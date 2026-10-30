"""Measured MediaPipe world poses -> explicitly approximate HumanML3D features.

The retarget uses no facial coordinates. It derives torso/root/collar/head joints
from measured body joints and records those approximations in the response.
Global travel cannot be recovered from MediaPipe's hip-centred world coordinates.
"""
from __future__ import annotations

import math
from typing import Any
import numpy as np

BODY_JOINTS = (
    'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow',
    'leftWrist', 'rightWrist', 'leftPinky', 'rightPinky',
    'leftIndex', 'rightIndex', 'leftThumb', 'rightThumb',
    'leftHip', 'rightHip', 'leftKnee', 'rightKnee',
    'leftAnkle', 'rightAnkle', 'leftHeel', 'rightHeel',
    'leftFootIndex', 'rightFootIndex',
)
REQUIRED_JOINTS = tuple(name for name in BODY_JOINTS
                        if not any(part in name for part in ('Pinky', 'Index', 'Thumb', 'Heel')) or 'FootIndex' in name)
HUMANML_JOINTS = (
    'pelvis', 'leftHip', 'rightHip', 'spine1', 'leftKnee', 'rightKnee',
    'spine2', 'leftAnkle', 'rightAnkle', 'spine3', 'leftFoot', 'rightFoot',
    'neck', 'leftCollar', 'rightCollar', 'head', 'leftShoulder',
    'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
)
INFERRED_JOINTS = ('pelvis', 'spine1', 'spine2', 'spine3', 'neck',
                   'leftCollar', 'rightCollar', 'head')
MAX_FRAMES = 512
MAX_GAP_MS = 250
MIN_SPAN_MS = 1000
FPS = 20
MAX_RESAMPLED_FRAMES = 196


class MotionInputError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def finite_number(value: Any, low: float, high: float) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and low <= value <= high


def measured_segments(payload: Any) -> tuple[list[list[dict]], int]:
    if not isinstance(payload, dict) or set(payload) - {'source', 'durationMs', 'samples'}:
        raise MotionInputError('INVALID_MOTION', 'Motion service accepts only source, durationMs and world-coordinate samples.')
    if payload.get('source') != 'webcam':
        raise MotionInputError('FULL_BODY_REQUIRED', 'MotionGPT requires measured full-body 3D poses; hand and 2D traces are not accepted.')
    duration = payload.get('durationMs')
    if not finite_number(duration, 1, 15000):
        raise MotionInputError('INVALID_MOTION', 'durationMs must be between 1 and 15000.')
    samples = payload.get('samples')
    if not isinstance(samples, list) or not 2 <= len(samples) <= MAX_FRAMES:
        raise MotionInputError('INVALID_MOTION', 'Provide 2 to 512 measured world-coordinate frames.')
    segments, current = [], []
    previous_t = -1
    for frame in samples:
        if not isinstance(frame, dict) or set(frame) - {'t', 'segment', 'worldJoints', 'breakBefore'}:
            raise MotionInputError('INVALID_MOTION', 'Unsupported frame field.')
        t = frame.get('t')
        segment = frame.get('segment')
        if not finite_number(t, 0, duration) or t <= previous_t:
            raise MotionInputError('INVALID_MOTION', 'Frame times must increase within the capture duration.')
        if not isinstance(segment, int) or isinstance(segment, bool) or not 0 <= segment <= 100000:
            raise MotionInputError('INVALID_MOTION', 'Every frame needs an integer segment ID.')
        if 'breakBefore' in frame and not isinstance(frame['breakBefore'], bool):
            raise MotionInputError('INVALID_MOTION', 'breakBefore must be boolean.')
        previous_t = t
        joints = frame.get('worldJoints')
        if not isinstance(joints, dict) or set(joints) - set(BODY_JOINTS):
            raise MotionInputError('INVALID_WORLD_POSE', 'Only the 22 supported body joints are accepted; face joints are never accepted.')
        for point in joints.values():
            if not isinstance(point, list) or len(point) != 3 or not all(finite_number(x, -20, 20) for x in point):
                raise MotionInputError('INVALID_WORLD_POSE', 'World joints must be finite XYZ metre estimates within -20..20.')
        if any(name not in joints for name in REQUIRED_JOINTS):
            if current:
                segments.append(current)
                current = []
            continue
        if current and (frame.get('breakBefore') or segment != current[-1]['segment'] or t - current[-1]['t'] > MAX_GAP_MS):
            segments.append(current)
            current = []
        current.append(frame)
    if current:
        segments.append(current)
    return segments, len(samples)


def resample_measured_world(payload: Any) -> tuple[np.ndarray, dict]:
    segments, total = measured_segments(payload)
    candidates = [part for part in segments if len(part) >= 8 and part[-1]['t'] - part[0]['t'] >= MIN_SPAN_MS]
    if not candidates:
        raise MotionInputError('INSUFFICIENT_3D_MOTION', 'At least one continuous second with shoulders, elbows, wrists, hips, knees, ankles and toes is required.')
    selected = max(candidates, key=lambda part: part[-1]['t'] - part[0]['t'])
    start, end = selected[0]['t'], selected[-1]['t']
    frame_count = min(MAX_RESAMPLED_FRAMES, int(math.floor((end - start) * FPS / 1000)) + 1)
    used_span = (frame_count - 1) * 1000 / FPS
    used_start = start + ((end - start) - used_span) / 2
    times = used_start + np.arange(frame_count, dtype=np.float64) * 1000 / FPS
    source_t = np.array([frame['t'] for frame in selected], dtype=np.float64)
    raw = np.array([[frame['worldJoints'][name] for name in REQUIRED_JOINTS] for frame in selected], dtype=np.float64)
    result = np.empty((frame_count, len(REQUIRED_JOINTS), 3), dtype=np.float64)
    for joint in range(len(REQUIRED_JOINTS)):
        for axis in range(3):
            result[:, joint, axis] = np.interp(times, source_t, raw[:, joint, axis])
    # MediaPipe world coordinates -> Y-up. Do not apply display mirroring to 3D.
    result *= np.array([1.0, -1.0, -1.0])
    return result, {
        'inputFrames': total, 'selectedMeasuredFrames': len(selected),
        'validSegments': len(candidates), 'segmentId': selected[0]['segment'],
        'usedStartMs': round(float(used_start), 3), 'usedDurationMs': round(float(used_span), 3),
        'resampledFps': FPS, 'resampledFrames': frame_count,
        'measuredJoints': list(REQUIRED_JOINTS), 'inferredJoints': list(INFERRED_JOINTS),
        'worldCoordinateSource': 'MediaPipe estimated hip-centred world XYZ',
        'rootTranslationAvailable': False,
        'rootTranslationNote': 'Hip-centred world coordinates do not measure global travel or absolute jump height.',
        'retargetMethod': 'Body-derived torso/head and capture-median bone lengths; approximate HumanML3D retarget, not motion-capture ground truth.',
    }


def humanml_joints(measured: np.ndarray) -> np.ndarray:
    points = {name: measured[:, i] for i, name in enumerate(REQUIRED_JOINTS)}
    pelvis = (points['leftHip'] + points['rightHip']) / 2
    shoulders = (points['leftShoulder'] + points['rightShoulder']) / 2
    torso = shoulders - pelvis
    if np.any(np.linalg.norm(torso, axis=1) < 0.08):
        raise MotionInputError('DEGENERATE_SKELETON', 'Measured torso is too short or collapsed.')
    joints = np.empty((len(measured), 22, 3), dtype=np.float64)
    mapping = {1:'leftHip',2:'rightHip',4:'leftKnee',5:'rightKnee',7:'leftAnkle',8:'rightAnkle',
               10:'leftFootIndex',11:'rightFootIndex',16:'leftShoulder',17:'rightShoulder',
               18:'leftElbow',19:'rightElbow',20:'leftWrist',21:'rightWrist'}
    for index, name in mapping.items():
        joints[:, index] = points[name]
    joints[:, 0] = pelvis
    for index, ratio in ((3,.25),(6,.5),(9,.75)):
        joints[:, index] = pelvis + ratio * torso
    joints[:, 12] = shoulders + .1 * torso
    joints[:, 15] = shoulders + .45 * torso
    joints[:, 13] = shoulders + .35 * (points['leftShoulder'] - shoulders)
    joints[:, 14] = shoulders + .35 * (points['rightShoulder'] - shoulders)
    return joints


def features_from_world(payload: Any, mean: np.ndarray, std: np.ndarray) -> tuple[np.ndarray, dict]:
    import torch
    from .vendor.mgpt.data.humanml.common.skeleton import Skeleton
    from .vendor.mgpt.data.humanml.common.quaternion import qbetween_np, qrot_np
    from .vendor.mgpt.data.humanml.scripts.motion_process import extract_features
    from .vendor.mgpt.data.humanml.utils.paramUtil import t2m_raw_offsets, t2m_kinematic_chain

    measured, metadata = resample_measured_world(payload)
    positions = humanml_joints(measured)
    offsets = torch.from_numpy(t2m_raw_offsets).float()
    skeleton = Skeleton(offsets, t2m_kinematic_chain, 'cpu')
    parents = skeleton.parents()
    bone_lengths = np.stack([np.linalg.norm(positions[:, i] - positions[:, parents[i]], axis=-1) for i in range(1,22)],axis=1)
    if np.any(np.median(bone_lengths, axis=0) < .005):
        raise MotionInputError('DEGENERATE_SKELETON', 'Measured bone lengths are collapsed.')
    target_offsets = offsets.clone()
    target_offsets[1:] *= torch.from_numpy(np.median(bone_lengths,axis=0)).float()[:, None]
    # Stabilize bone lengths within this capture, without inventing locomotion.
    quaternion = skeleton.inverse_kinematics_np(positions, [2,1,17,16])
    skeleton.set_offset(target_offsets)
    positions = skeleton.forward_kinematics_np(quaternion, positions[:,0])
    positions[:,:,1] -= positions[:,:,1].min()
    positions -= positions[0,0] * np.array([1,0,1])
    across = positions[0,2] - positions[0,1] + positions[0,17] - positions[0,16]
    forward = np.cross(np.array([0,1,0]), across)
    norm = np.linalg.norm(forward)
    if not np.isfinite(norm) or norm < 1e-6:
        raise MotionInputError('DEGENERATE_SKELETON', 'Torso facing direction is unavailable.')
    rotation = qbetween_np((forward / norm)[None], np.array([[0.,0.,1.]]))
    rotation = np.broadcast_to(rotation, positions.shape[:-1] + (4,)).copy()
    positions = qrot_np(rotation, positions)
    features = extract_features(positions, .002, offsets, t2m_kinematic_chain, [2,1,17,16], [8,11], [7,10])
    if mean.shape != (263,) or std.shape != (263,) or not np.all(np.isfinite(mean)) or not np.all(np.isfinite(std)) or np.any(std <= 0):
        raise MotionInputError('INVALID_NORMALIZATION', 'Official MotionGPT mean/std must contain 263 finite values and positive standard deviations.')
    if features.ndim != 2 or features.shape[1] != 263 or not np.all(np.isfinite(features)):
        raise MotionInputError('DEGENERATE_SKELETON', 'Retargeting produced invalid HumanML3D features; record a clearer full-body movement.')
    normalized = ((features - mean) / std).astype(np.float32)
    metadata.update({'featureDimensions':263,'featureFrames':len(features),'normalization':'Official MotionGPT HumanML3D mean/std'})
    return normalized, metadata
