"""Record drafts reuse the append-only audit journal; no schema or signed-row changes."""
import json

FACT_FIELDS = {'pain_score_0_10', 'drainage_level', 'dressing_condition', 'redness_observed',
               'concern_reported', 'non_diagnostic_notes'}
CLINICAL_FIELDS = {'wound_type', 'pressure_injury_stage', 'diagnosis', 'wound_bed_appearance',
                   'exudate_amount', 'surrounding_skin', 'wound_trend', 'sensory_perception',
                   'moisture', 'activity', 'mobility', 'nutrition', 'friction_and_shear',
                   'clinical_interpretation', 'care_decisions', 'ai_draft_disposition', 'final_documentation_text'}
SCORES = {'sensory_perception', 'moisture', 'activity', 'mobility', 'nutrition', 'friction_and_shear'}
RECORD_ACTIONS = ('RECORD_DRAFT_SAVED', 'RECORD_SUBMITTED', 'RECORD_APPROVED', 'RECORD_AMENDMENT_APPROVED')


def facts_raise_concern(fields):
    pain = fields.get('pain_score_0_10')
    return (fields.get('concern_reported') is True or fields.get('redness_observed') == 'YES'
            or (type(pain) is int and pain >= 6))


def validate_fields(fields, clinical):
    if not isinstance(fields, dict) or set(fields) - (FACT_FIELDS | (CLINICAL_FIELDS if clinical else set())):
        raise ValueError('Unsupported or unauthorised record fields.')
    if len(json.dumps(fields)) > 24000:
        raise ValueError('Record details are too long.')
    choices = {'drainage_level': {'NONE','SMALL','MODERATE','LARGE','UNSURE'},
               'dressing_condition': {'INTACT','LOOSE','WET','OTHER','UNSURE'},
               'redness_observed': {'YES','NO','UNSURE'}}
    for key, value in fields.items():
        if key == 'pain_score_0_10':
            if value is not None and (type(value) is not int or not 0 <= value <= 10):
                raise ValueError('Pain must be an integer from 0 to 10, or unknown.')
        elif key == 'concern_reported':
            if type(value) is not bool: raise ValueError('Concern must be true or false.')
        elif key in SCORES:
            if type(value) is not int or not 0 <= value <= (3 if key == 'friction_and_shear' else 4):
                raise ValueError('Invalid Braden score.')
        elif key in choices:
            if value is not None and value not in choices[key]: raise ValueError('Unsupported factual observation.')
        elif not isinstance(value, str) or len(value) > 4000:
            raise ValueError('Record text must contain at most 4000 characters.')


class RecordWorkflow:
    def _record_events(self, conn, observation_id):
        rows = conn.execute("SELECT * FROM audit_events WHERE entity_id=? AND action IN (?,?,?,?) ORDER BY sequence_id",
                            (observation_id, *RECORD_ACTIONS)).fetchall()
        return [{**dict(row), 'detail': json.loads(row['detail_json'])} for row in rows]

    def _record_workspace(self, conn, obs, actor, clinical):
        report = conn.execute('SELECT * FROM caregiver_reports WHERE observation_id=?', (obs['observation_id'],)).fetchone()
        fields = {key: dict(report).get(key) for key in FACT_FIELDS} if report else {}
        if 'concern_reported' in fields: fields['concern_reported'] = bool(fields['concern_reported'])
        assessments = conn.execute('SELECT * FROM clinical_assessments WHERE observation_id=? ORDER BY version_number DESC, sequence_id DESC', (obs['observation_id'],)).fetchall()
        base = dict(assessments[0]) if assessments else None
        if clinical and base:
            fields.update({key: base.get(key, '') for key in CLINICAL_FIELDS - SCORES - {'diagnosis'}})
            fields['diagnosis'] = base.get('diagnosis_text') or ''
        events = self._record_events(conn, obs['observation_id'])
        published = dict(fields)
        visible = []
        pending_fields = {}
        pending_reason = ""
        for event in events:
            detail = event['detail']
            if event['action'] in ('RECORD_APPROVED','RECORD_AMENDMENT_APPROVED'):
                published.update(detail.get('fields', {}))
            if clinical or event['actor_subject'] == actor:
                # Pending proposals never become authoritative merely because they were saved.
                if detail.get('base_assessment_id') == (base['assessment_id'] if base else None):
                    pending_fields.update(detail.get('fields', {}))
                    pending_reason = detail.get('reason', '')
                visible.append({'revision': detail.get('revision'), 'action': event['action'],
                                'actor': event['actor_subject'], 'timestamp': event['timestamp_utc'],
                                'fields': detail.get('fields', {}), 'changes': detail.get('changes', {}),
                                'reason': detail.get('reason', ''), 'assessment_id': detail.get('assessment_id'),
                                'ai_assisted': bool(detail.get('ai_revision_ids'))})
        if base:
            # Begin new amendments from the latest signed clinical values, not stale draft snapshots.
            published.update({key: base.get(key, '') for key in CLINICAL_FIELDS - SCORES - {'diagnosis'}})
        fields = {**published, **pending_fields}
        if not clinical:
            fields = {key: value for key, value in fields.items() if key in FACT_FIELDS}
            published = {key: value for key, value in published.items() if key in FACT_FIELDS}
        return {'record_has_draft': bool(pending_fields), 'record_amendment_reason': pending_reason, 'record_revision': len(events), 'record_draft': fields, 'record_published': published,
                'record_history': visible, 'record_base_assessment_id': base['assessment_id'] if base else None}

    def save_record_draft(self, *, actor_subject, observation_id, fields, expected_revision,
                          base_assessment_id=None, amendment_reason='', submit=False, ai_revision_ids=None):
        from app.services.connected_care_db import AccessDeniedError, ClinicalConflictError, CLINICAL_ROLES
        with self._lock, self._connect() as conn:
            conn.execute('SELECT pg_advisory_xact_lock(4456001)')
            row = conn.execute('SELECT * FROM wound_observations WHERE observation_id=?', (observation_id,)).fetchone()
            if not row: raise KeyError('Observation not found.')
            obs = dict(row)
            user, _ = self.authorize_patient_access(conn, actor_subject, obs['patient_id'], wound_id=obs['wound_id'])
            clinical = user['role'] in CLINICAL_ROLES
            if clinical:
                self.require_permission(conn,user,'ASSESS',patient_id=obs['patient_id'],wound_id=obs['wound_id'])
            elif user['role'] != 'FAMILY_CAREGIVER' or obs['uploading_user_subject'] != actor_subject:
                raise AccessDeniedError('RECORD_EDIT_DENIED', 'Only authorised staff or the original authorised caregiver can edit this record.')
            self.require_active_record(conn,'observation',observation_id)
            if obs['review_state'] not in ('AWAITING_CLINICAL_REVIEW','CLINICIAN_APPROVED'):
                raise ClinicalConflictError('This record is closed to editing.')
            if not clinical:
                self.authorize_patient_access(conn, actor_subject, obs['patient_id'], wound_id=obs['wound_id'], required_permission='UPLOAD_HOME_PHOTO')
            validate_fields(fields,clinical)
            workspace = self._record_workspace(conn,obs,actor_subject,clinical)
            if expected_revision != workspace['record_revision'] or base_assessment_id != workspace['record_base_assessment_id']:
                raise ClinicalConflictError('Record changed. Reload the saved version before editing.')
            if base_assessment_id and not amendment_reason.strip():
                raise ValueError('A concise amendment reason is required.')
            before = workspace['record_draft']
            if clinical:
                for keys, permission in (({'wound_type','pressure_injury_stage'}, 'STAGE'), ({'diagnosis'}, 'DIAGNOSE')):
                    if any(key in fields and fields[key] != before.get(key) for key in keys):
                        self.require_permission(conn,user,permission,patient_id=obs['patient_id'],wound_id=obs['wound_id'])
            changed = {key: {'old': before.get(key), 'new': value} for key,value in fields.items() if before.get(key) != value}
            # Muse Spark wording the clinician applied before saving (audited suggestions for this wound).
            ai_ids = self.validate_ai_revision_ids(conn, ai_revision_ids, obs['patient_id'], obs['wound_id'], draft_types=('clinical_note',),
                                                   actor_subject=actor_subject, target_id=observation_id) if clinical else []
            if base_assessment_id and amendment_reason.strip() != workspace['record_amendment_reason']:
                changed['amendment_reason'] = {'old':workspace['record_amendment_reason'],'new':amendment_reason.strip()}
            if changed or submit:
                self._append_audit(conn,actor_subject=actor_subject,actor_role=user['role'],actor_org_id=user['org_id'],
                    patient_id=obs['patient_id'],wound_id=obs['wound_id'],entity_type='OBSERVATION',entity_id=observation_id,
                    action='RECORD_SUBMITTED' if submit else 'RECORD_DRAFT_SAVED',
                    detail={'revision':workspace['record_revision']+1,'base_assessment_id':base_assessment_id,
                            'fields':{**before,**fields},'changes':changed,'reason':amendment_reason.strip(),
                            **({'ai_revision_ids':ai_ids} if ai_ids else {})})
            if (changed or submit) and facts_raise_concern(fields):
                conn.execute("UPDATE review_requests SET priority_level='RED' WHERE observation_id=? AND priority_level!='RED'", (observation_id,))
            if submit:
                conn.execute("UPDATE review_requests SET status='AWAITING_CLINICAL_REVIEW' WHERE observation_id=?", (observation_id,))
            return self.get_observation_detail(actor_subject=actor_subject,observation_id=observation_id,conn_override=conn)

    def photo_correction_context(self, actor_subject, observation_id):
        from app.services.connected_care_db import AccessDeniedError, CLINICAL_ROLES
        with self._connect() as conn:
            row = conn.execute('SELECT * FROM wound_observations WHERE observation_id=?', (observation_id,)).fetchone()
            if not row: raise KeyError('Original record not found.')
            obs = dict(row)
            user, _ = self.authorize_patient_access(conn, actor_subject, obs['patient_id'], wound_id=obs['wound_id'], required_permission='UPLOAD_HOME_PHOTO')
            self.require_active_record(conn,'observation',observation_id)
            if user['role'] in CLINICAL_ROLES:
                self.require_permission(conn,user,'CAPTURE',patient_id=obs['patient_id'],wound_id=obs['wound_id'])
            elif user['role'] != 'FAMILY_CAREGIVER' or obs['uploading_user_subject'] != actor_subject:
                raise AccessDeniedError('RECORD_EDIT_DENIED','Only authorised staff or the original caregiver can propose a photo correction.')
            return obs

    def _journal_photo_correction(self, conn, user, patient_id, wound_id, observation_id, original_id, reason):
        if not original_id: return
        # Commit the relationship with the observation, new files and upload receipt.
        # Re-check deletion after processing; rollback removes only newly created files.
        self.require_active_record(conn,'observation',original_id)
        self._append_audit(conn,actor_subject=user['subject'],actor_role=user['role'],actor_org_id=user['org_id'],
            patient_id=patient_id,wound_id=wound_id,action='RECORD_PHOTO_CORRECTION',entity_type='OBSERVATION',
            entity_id=observation_id,detail={'original_id':original_id,'reason':reason.strip()})

    def _photo_relationships(self, conn, obs, actor_subject, clinical):
        result = {'correction_of':None,'photo_corrections':[]}
        for row in conn.execute("SELECT entity_id,detail_json,timestamp_utc,actor_subject FROM audit_events WHERE action='RECORD_PHOTO_CORRECTION' AND patient_id=? AND wound_id=? ORDER BY sequence_id",(obs['patient_id'],obs['wound_id'])):
            detail=json.loads(row['detail_json'])
            if row['entity_id']==obs['observation_id']: result['correction_of']=detail['original_id']
            if (clinical or obs['uploading_user_subject'] == actor_subject) and detail['original_id']==obs['observation_id']:
                # Never expose deleted evidence through a correction link.
                deleted=conn.execute("SELECT 1 FROM record_deletions WHERE record_type='observation' AND record_id=? AND restored_at_utc IS NULL",(row['entity_id'],)).fetchone()
                correction = conn.execute('SELECT uploading_user_subject, review_state FROM wound_observations WHERE observation_id=?',(row['entity_id'],)).fetchone()
                if not deleted and correction and (clinical or correction['uploading_user_subject'] == actor_subject or correction['review_state'] == 'CLINICIAN_APPROVED'):
                    reason = detail['reason'] if clinical or row['actor_subject'] == actor_subject else 'Clinician photo correction'
                    result['photo_corrections'].append({'observation_id':row['entity_id'],'reason':reason,'timestamp':row['timestamp_utc']})
        return result
