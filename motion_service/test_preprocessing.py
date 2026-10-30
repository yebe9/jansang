"""Independent tests: python -m unittest motion_service.test_preprocessing"""
from __future__ import annotations
import copy
import http.client
import json
import math
from pathlib import Path
import tempfile
import threading
import unittest
import numpy as np
from .preprocessing import (MotionInputError, REQUIRED_JOINTS, INFERRED_JOINTS,
                            resample_measured_world, humanml_joints, features_from_world)
from .runtime import MotionRuntime, ServiceError
from .server import CaptionServer, Handler, MAX_BODY_BYTES


def fixture(duration_ms=2000, offset_ms=0, segment=0):
    """Synthetic 3D body motion for contract tests; not a captured human video."""
    base = {
        'leftShoulder':[.20,-.50,.02], 'rightShoulder':[-.20,-.50,-.02],
        'leftElbow':[.36,-.28,.04], 'rightElbow':[-.36,-.28,-.04],
        'leftWrist':[.40,-.08,.08], 'rightWrist':[-.40,-.08,-.08],
        'leftHip':[.10,0,.01], 'rightHip':[-.10,0,-.01],
        'leftKnee':[.12,.42,.02], 'rightKnee':[-.12,.42,-.02],
        'leftAnkle':[.12,.82,-.02], 'rightAnkle':[-.12,.82,.02],
        'leftFootIndex':[.13,.86,-.18], 'rightFootIndex':[-.13,.86,-.18],
    }
    samples = []
    for i,t in enumerate(range(0,duration_ms+1,50)):
        joints=copy.deepcopy(base)
        joints['leftWrist'][1] -= .12 * math.sin(i*.2)
        joints['leftWrist'][2] += .06 * math.sin(i*.15)
        joints['leftElbow'][0] += .04 * math.sin(i*.1)
        samples.append({'t':t+offset_ms,'segment':segment,'worldJoints':joints})
    return {'source':'webcam','durationMs':duration_ms+offset_ms,'samples':samples}


class PreprocessingTests(unittest.TestCase):
    def test_real_3d_contract_produces_263_finite_features(self):
        features, meta=features_from_world(fixture(),np.zeros(263),np.ones(263))
        self.assertEqual(features.shape,(40,263))
        self.assertEqual(features.dtype,np.float32)
        self.assertTrue(np.isfinite(features).all())
        self.assertFalse(meta['rootTranslationAvailable'])
        self.assertEqual(meta['inferredJoints'],list(INFERRED_JOINTS))
        self.assertEqual(len(meta['measuredJoints']),14)
        self.assertIn('head',meta['inferredJoints'])
        self.assertNotIn('head',meta['measuredJoints'])

    def test_static_world_translation_is_removed(self):
        first,_=features_from_world(fixture(),np.zeros(263),np.ones(263))
        payload=fixture()
        for frame in payload['samples']:
            for point in frame['worldJoints'].values():
                point[0]+=.4; point[1]+=.3; point[2]-=.2
        second,_=features_from_world(payload,np.zeros(263),np.ones(263))
        np.testing.assert_allclose(first,second,atol=2e-5)

    def test_longest_observed_segment_is_resampled_without_joining_gap(self):
        short=fixture(1000)
        long=fixture(2000,1600,1)
        payload={'source':'webcam','durationMs':3600,'samples':short['samples']+long['samples']}
        values,meta=resample_measured_world(payload)
        self.assertEqual(meta['segmentId'],1)
        self.assertEqual(meta['usedStartMs'],1600)
        self.assertEqual(meta['resampledFps'],20)
        self.assertEqual(len(values),41)

    def test_missing_joint_breaks_continuity_instead_of_being_filled(self):
        payload=fixture()
        del payload['samples'][20]['worldJoints']['leftWrist']
        with self.assertRaisesRegex(MotionInputError,'continuous second'):
            resample_measured_world(payload)

    def test_large_time_gap_is_not_interpolated(self):
        payload=fixture()
        payload['samples']=[frame for frame in payload['samples'] if frame['t']<900 or frame['t']>1200]
        with self.assertRaises(MotionInputError):
            resample_measured_world(payload)

    def test_hand_and_2d_inputs_are_rejected(self):
        payload=fixture(); payload['source']='hand'
        with self.assertRaisesRegex(MotionInputError,'full-body'):
            resample_measured_world(payload)
        payload=fixture(); payload['samples'][0]['worldJoints']['leftHip']=[.1,.2]
        with self.assertRaisesRegex(MotionInputError,'XYZ'):
            resample_measured_world(payload)

    def test_face_and_unknown_joints_are_not_accepted(self):
        payload=fixture();payload['samples'][0]['worldJoints']['nose']=[0,0,0]
        with self.assertRaisesRegex(MotionInputError,'face joints'):
            resample_measured_world(payload)

    def test_coordinate_range_and_nonfinite_values_are_rejected(self):
        for value in (21,float('nan'),float('inf'),True):
            payload=fixture();payload['samples'][0]['worldJoints']['leftHip'][0]=value
            with self.assertRaises(MotionInputError):
                resample_measured_world(payload)

    def test_nonincreasing_times_and_unknown_payload_fields_fail(self):
        payload=fixture();payload['samples'][1]['t']=0
        with self.assertRaises(MotionInputError):resample_measured_world(payload)
        payload=fixture();payload['intention']='private'
        with self.assertRaises(MotionInputError):resample_measured_world(payload)

    def test_inferred_head_uses_body_only(self):
        measured,meta=resample_measured_world(fixture())
        positions=humanml_joints(measured)
        self.assertEqual(positions.shape,(41,22,3))
        shoulder=(positions[:,16]+positions[:,17])/2
        pelvis=(positions[:,1]+positions[:,2])/2
        np.testing.assert_allclose(positions[:,15],shoulder+.45*(shoulder-pelvis))
        self.assertIn('head',meta['inferredJoints'])

    def test_invalid_normalization_is_not_used(self):
        with self.assertRaisesRegex(MotionInputError,'mean/std'):
            features_from_world(fixture(),np.zeros(263),np.zeros(263))

    def test_frame_count_and_resampled_model_window_are_bounded(self):
        payload=fixture(10000)
        values,meta=resample_measured_world(payload)
        self.assertEqual(len(values),196)
        self.assertEqual(meta['usedDurationMs'],9750)
        payload=fixture();payload['samples']=payload['samples']*13
        with self.assertRaises(MotionInputError):resample_measured_world(payload)

    def test_model_readiness_is_false_without_real_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            model=MotionRuntime(Path(directory))
            self.assertFalse(model.health()['ready'])
            self.assertEqual(model.health()['status'],'not_configured')
            with self.assertRaises(ServiceError):model.load()
            self.assertFalse(model.health()['ready'])

    def test_busy_cpu_is_reported_before_any_model_inference(self):
        with tempfile.TemporaryDirectory() as directory:
            model=MotionRuntime(Path(directory))
            model._inference_lock.acquire()
            try:
                with self.assertRaises(ServiceError) as raised:model.caption(fixture())
                self.assertEqual(raised.exception.status,429)
            finally:model._inference_lock.release()


class TransportRuntime:
    # HTTP boundary tests use an explicit stub and never claim model readiness.
    def health(self):return {'ready':False,'status':'test-transport-only'}
    def caption(self,payload):
        if payload.get('source')!='webcam':raise MotionInputError('FULL_BODY_REQUIRED','Full body required')
        return {'accepted':True}


class HttpBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=CaptionServer(('127.0.0.1',0),Handler)
        cls.server.runtime=TransportRuntime()
        cls.worker=threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.worker.start()
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.worker.join(timeout=2)
    def request(self,method,path,body=None,headers=None):
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_address[1],timeout=5)
        try:
            connection.request(method,path,body=body,headers=headers or {})
            response=connection.getresponse();status=response.status;value=json.loads(response.read())
            return status,value
        finally:connection.close()
    def test_health_does_not_claim_a_loaded_model(self):
        status,value=self.request('GET','/health')
        self.assertEqual(status,200);self.assertFalse(value['ready'])
    def test_external_origin_is_denied(self):
        status,_=self.request('POST','/caption','{}',{'Origin':'https://evil.example','Content-Type':'application/json'})
        self.assertEqual(status,403)
    def test_untrusted_host_is_denied(self):
        status,_=self.request('GET','/health',headers={'Host':'evil.example'})
        self.assertEqual(status,403)
    def test_cross_site_browser_requests_are_denied(self):
        status,_=self.request('GET','/health',headers={'Sec-Fetch-Site':'cross-site'})
        self.assertEqual(status,403)
    def test_oversized_declared_body_is_rejected_without_reading_it(self):
        status,_=self.request('POST','/caption','{}',{'Content-Type':'application/json','Content-Length':str(MAX_BODY_BYTES+1)})
        self.assertEqual(status,413)
    def test_nonfinite_json_and_unsupported_content_type_are_denied(self):
        status,_=self.request('POST','/caption','{"source":"webcam","bad":NaN}',{'Content-Type':'application/json'})
        self.assertEqual(status,400)
        status,_=self.request('POST','/caption','{}',{'Content-Type':'text/plain'})
        self.assertEqual(status,415)
    def test_valid_local_json_reaches_runtime_and_errors_are_structured(self):
        status,value=self.request('POST','/caption','{"source":"webcam"}',{'Content-Type':'application/json'})
        self.assertEqual(status,200);self.assertTrue(value['accepted'])
        status,value=self.request('POST','/caption','{"source":"hand"}',{'Content-Type':'application/json'})
        self.assertEqual(status,400);self.assertEqual(value['error']['code'],'FULL_BODY_REQUIRED')


if __name__=='__main__':unittest.main()
