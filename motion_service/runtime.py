"""Small CPU-only MotionGPT inference wrapper, without render/training modules."""
from __future__ import annotations
import gc
import hashlib
import json
import os
from pathlib import Path
import pickle
import threading
import time
import numpy as np
from .download_models import SERVICE_DIR, model_directory, digest
from .preprocessing import measured_segments, features_from_world


class ServiceError(RuntimeError):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code = status, code
        super().__init__(message)


class MotionRuntime:
    def __init__(self, directory: Path | None = None):
        self.directory = Path(directory) if directory else model_directory()
        self.manifest = json.loads((SERVICE_DIR / 'model-artifacts.json').read_text(encoding='utf-8'))
        self.source_manifest = json.loads((SERVICE_DIR / 'upstream.json').read_text(encoding='utf-8'))
        self.state = 'not_loaded'
        self.last_error = None
        self._load_lock = threading.Lock()
        self._inference_lock = threading.Lock()
        self.vae, self.lm, self.mean, self.std = None, None, None, None
        self.dtype = 'float32'

    def missing_assets(self) -> list[str]:
        missing = []
        for entry in self.manifest['files']:
            path = self.directory / entry['path']
            if not path.is_file() or path.stat().st_size != entry['bytes']:
                missing.append(entry['path'])
        for entry in self.source_manifest['files']:
            if not (SERVICE_DIR / entry['local']).is_file():
                missing.append(entry['local'])
        return missing

    def health(self) -> dict:
        missing = self.missing_assets()
        return {
            'ready': self.state == 'ready' and self.vae is not None and self.lm is not None,
            'status': 'not_configured' if missing else self.state,
            'provider': 'MotionGPT', 'model': self.manifest['model'], 'device': 'cpu',
            'dtype': self.dtype, 'busy': self._inference_lock.locked(),
            'missingAssets': missing, 'error': self.last_error,
            'weightsLicense': self.manifest['weightsLicense'],
        }

    def _verify_assets(self) -> None:
        if self.missing_assets():
            raise ServiceError(503, 'MOTIONGPT_NOT_CONFIGURED', 'Run python -m motion_service.download_models to install the pinned source and model assets.')
        for entry in self.manifest['files']:
            if digest(self.directory / entry['path']) != entry['sha256']:
                raise ServiceError(503, 'MODEL_HASH_MISMATCH', 'A pinned MotionGPT asset failed its SHA-256 check. Download the official assets again.')
        for entry in self.source_manifest['files']:
            if digest(SERVICE_DIR / entry['local']) != entry['sha256']:
                raise ServiceError(503, 'SOURCE_HASH_MISMATCH', 'A vendored MotionGPT source failed its SHA-256 check. Reinstall the pinned sources.')

    def load(self) -> None:
        with self._load_lock:
            if self.state == 'ready':
                return
            self.state, self.last_error = 'loading', None
            try:
                self._verify_assets()
                os.environ['CUDA_VISIBLE_DEVICES'] = ''
                import torch
                from .vendor.mgpt.archs.mgpt_vq import VQVae
                from .vendor.mgpt.archs.mgpt_lm import MLM
                threads = int(os.environ.get('MOTIONGPT_CPU_THREADS', min(4, os.cpu_count() or 1)))
                torch.set_num_threads(max(1, min(threads, 16)))
                # This path has no CUDA/SMPL/Whisper dependency and never selects a GPU.
                checkpoint_path = self.directory / 'motiongpt_s3_h3d.tar'
                try:
                    checkpoint = torch.load(checkpoint_path, map_location='cpu', weights_only=True)
                except pickle.UnpicklingError:
                    # The known official Lightning checkpoint may include metadata that
                    # safe tensor-only unpickling rejects. This fallback is permitted
                    # only after the complete file matches the pinned official SHA-256.
                    checkpoint = torch.load(checkpoint_path, map_location='cpu', weights_only=False)
                state = checkpoint.get('state_dict')
                if not isinstance(state, dict):
                    raise ServiceError(503, 'INVALID_CHECKPOINT', 'The official checkpoint has no state_dict.')
                vae = VQVae(nfeats=263, quantizer='ema_reset', code_num=512, code_dim=512,
                            output_emb_width=512, down_t=2, stride_t=2, width=512,
                            depth=3, dilation_growth_rate=3, norm=None, activation='relu')
                vae_state = {key[4:]:value for key,value in state.items() if key.startswith('vae.')}
                vae.load_state_dict(vae_state, strict=True)
                lm = MLM(model_path=str(self.directory / 'flan-t5-base'), model_type='t5',
                         stage='lm_instruct', new_token_type='insert', motion_codebook_size=512)
                lm_state = {key[3:]:value for key,value in state.items() if key.startswith('lm.')}
                lm.load_state_dict(lm_state, strict=True)
                vae.eval().cpu()
                lm.eval().cpu()
                if os.environ.get('MOTIONGPT_INT8') == '1':
                    lm.language_model = torch.quantization.quantize_dynamic(lm.language_model, {torch.nn.Linear}, dtype=torch.qint8)
                    self.dtype = 'dynamic-int8'
                mean = np.load(self.directory / 'meta' / 'mean.npy', allow_pickle=False)
                std = np.load(self.directory / 'meta' / 'std.npy', allow_pickle=False)
                if mean.shape != (263,) or std.shape != (263,) or not np.all(np.isfinite(mean)) or not np.all(np.isfinite(std)) or np.any(std <= 0):
                    raise ServiceError(503, 'INVALID_NORMALIZATION', 'Pinned HumanML3D mean/std are invalid.')
                self.vae, self.lm, self.mean, self.std = vae, lm, mean, std
                del checkpoint, state, vae_state, lm_state
                gc.collect()
                self.state = 'ready'
            except ServiceError as error:
                self.state, self.last_error = 'error', str(error)
                raise
            except Exception as error:
                self.state = 'error'
                self.last_error = 'MotionGPT could not load: ' + type(error).__name__
                raise ServiceError(503, 'MOTIONGPT_LOAD_FAILED', self.last_error) from error

    def warmup(self) -> None:
        try:
            self.load()
        except Exception:
            pass  # /health reports the real failure; startup itself remains responsive.

    def caption(self, payload: dict) -> dict:
        measured_segments(payload)  # Reject hands, 2D and malformed input before loading weights.
        if not self._inference_lock.acquire(blocking=False):
            raise ServiceError(429, 'MOTIONGPT_BUSY', 'The CPU motion model is already analysing another recording. Try again after it finishes.')
        started = time.monotonic()
        try:
            self.load()
            features, provenance = features_from_world(payload, self.mean, self.std)
            import torch
            with torch.inference_mode():
                codes, _ = self.vae.encode(torch.from_numpy(features)[None])
                captions = self.lm.generate_conditional(motion_tokens=[codes[0]],
                    lengths=[codes.shape[1]], task='m2t', stage='test')
            caption = captions[0].strip() if isinstance(captions, list) and captions and isinstance(captions[0], str) else ''
            if not caption or len(caption) > 2000:
                raise ServiceError(502, 'EMPTY_MOTION_CAPTION', 'The motion model did not produce a usable caption.')
            provenance.update({
                'sourceRevision': self.source_manifest['revision'],
                'checkpointRevision': self.manifest['checkpointRevision'],
                'checkpointSha256': self.manifest['files'][0]['sha256'],
                'weightsLicense': self.manifest['weightsLicense'], 'device':'cpu', 'dtype':self.dtype,
                'meanSha256': next(x['sha256'] for x in self.manifest['files'] if x['path']=='meta/mean.npy'),
                'stdSha256': next(x['sha256'] for x in self.manifest['files'] if x['path']=='meta/std.npy'),
            })
            return {'caption':caption,'provider':'MotionGPT','model':self.manifest['model'],
                    'frames':provenance['resampledFrames'],'elapsedMs':round((time.monotonic()-started)*1000),
                    'provenance':provenance}
        finally:
            self._inference_lock.release()
