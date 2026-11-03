import copy
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest

TEMP = tempfile.TemporaryDirectory()
os.environ['MARKINA_DATA'] = TEMP.name
os.environ['MARKINA_ORIGIN'] = 'http://localhost:8320'
import app as cms
from PIL import Image


class CMSTest(unittest.TestCase):
    def setUp(self):
        self.client = cms.app.test_client()
        self.seed = json.loads((cms.PUBLIC / 'content.json').read_text(encoding='utf-8'))
        self.origin = {'Origin': cms.ORIGIN}
        with cms.connect() as db:
            for table in ('owner', 'sessions', 'setup', 'attempts', 'revisions'):
                db.execute('DELETE FROM ' + table)
            db.execute("DELETE FROM sqlite_sequence WHERE name='revisions'")
            db.execute('INSERT INTO revisions(document) VALUES (?)', (json.dumps(self.seed),))
            db.execute('INSERT INTO setup VALUES (1,?,?)', (cms.digest('private-test-token'), int(time.time())+60))

    def login(self):
        result = self.client.post('/api/setup', json={'token':'private-test-token','password':'local-test-password'}, headers=self.origin)
        self.assertEqual(result.status_code, 200, result.json)
        self.csrf = {**self.origin, 'X-CSRF-Token':result.json['csrf']}
        return result

    def save(self, document, revision=1):
        return self.client.put('/api/admin/content', json={'revision':revision,'content':document}, headers=self.csrf)

    def test_first_setup_requires_secret_and_is_single_use(self):
        self.assertFalse(self.client.get('/api/session').json['initialized'])
        result = self.client.post('/api/setup', json={'token':'wrong','password':'local-test-password'}, headers=self.origin)
        self.assertEqual(result.status_code, 403)
        response = self.login()
        self.assertIn('HttpOnly', response.headers['Set-Cookie'])
        self.assertIn('SameSite=Strict', response.headers['Set-Cookie'])
        self.assertIn('Path=/api/', response.headers['Set-Cookie'])
        self.assertTrue(self.client.get('/api/session').json['authenticated'])
        result = self.client.post('/api/setup', json={'token':'private-test-token','password':'local-test-password'}, headers=self.origin)
        self.assertEqual(result.status_code, 403)

    def test_auth_origin_csrf_and_expiry(self):
        self.assertEqual(self.client.get('/api/admin/content').status_code,401)
        self.assertEqual(self.client.get('/api/admin/history').status_code,401)
        self.assertEqual(self.client.get('/api/admin/media').status_code,401)
        self.login()
        payload = {'revision':1,'content':self.seed}
        self.assertEqual(self.client.put('/api/admin/content',json=payload,headers=self.origin).status_code,403)
        self.assertEqual(self.client.put('/api/admin/content',json=payload,headers={**self.csrf,'Origin':'https://evil.test'}).status_code,403)
        with cms.connect() as db: db.execute('UPDATE sessions SET expires=0')
        self.assertEqual(self.client.get('/api/admin/content').status_code,401)

    def test_create_edit_hide_reorder_delete_and_history(self):
        self.login()
        doc = copy.deepcopy(self.seed)
        product = {**doc['products'][0], 'id':'test-product','name':'Новая работа','visible':False}
        doc['products'].insert(0, product)
        doc['sections']['heroTitle'] = 'Новый заголовок\nВторая строка'
        doc['faq'].append({'question':'Новый вопрос','answer':'Ответ'})
        response = self.save(doc)
        self.assertEqual(response.status_code,200,response.json)
        self.assertEqual(len(self.client.get('/api/content').json['content']['products']),6)
        self.assertEqual(len(self.client.get('/api/admin/content').json['content']['products']),7)
        product['visible'] = True
        product['description'] = 'Новое описание'
        self.assertEqual(self.save(doc,2).status_code,200)
        self.assertEqual(self.client.get('/api/content').json['content']['products'][0]['description'],'Новое описание')
        doc['products'].reverse()
        self.assertEqual(self.save(doc,3).status_code,200)
        doc['products'] = [p for p in doc['products'] if p['id'] != 'test-product']
        self.assertEqual(self.save(doc,4).status_code,200)
        self.assertEqual(len(self.client.get('/api/admin/history').json),5)
        self.assertEqual(self.client.get('/api/admin/history/1').json['content'],self.seed)
        self.assertEqual(self.client.get('/api/content').json['content']['sections']['heroTitle'],'Новый заголовок\nВторая строка')

    def test_concurrent_edit_does_not_overwrite(self):
        self.login()
        self.assertEqual(self.save(self.seed).status_code,200)
        result = self.save(self.seed)
        self.assertEqual(result.status_code,409)
        self.assertEqual(self.client.get('/api/content').json['revision'],2)

    def test_validation_blocks_active_links_paths_and_invalid_schema(self):
        self.login()
        variants = []
        for key, value in [('source','javascript:alert(1)'),('image','/uploads/../../server/app.py'),('types',[]),('visible','true')]:
            doc = copy.deepcopy(self.seed); doc['products'][0][key] = value; variants.append(doc)
        doc = copy.deepcopy(self.seed); doc['products'].append(doc['products'][0]); variants.append(doc)
        doc = copy.deepcopy(self.seed); doc['sections']['telegram']='http://example.test'; variants.append(doc)
        doc = copy.deepcopy(self.seed); doc['stories']=[]; variants.append(doc)
        for doc in variants:
            self.assertEqual(self.save(doc).status_code,400)
        self.assertEqual(self.client.get('/api/content').json['revision'],1)

    def test_upload_reencodes_and_rejects_non_image_and_private_paths(self):
        self.login()
        picture = Image.new('RGB',(60,80),(220,190,210)); stream=io.BytesIO(); picture.save(stream,'PNG'); stream.seek(0)
        result = self.client.post('/api/admin/upload',data={'file':(stream,'photo.png')},headers=self.csrf)
        self.assertEqual(result.status_code,201,result.json)
        self.assertTrue(result.json['url'].endswith('.webp'))
        response = self.client.get(result.json['url'])
        self.assertEqual(response.status_code,200)
        self.assertEqual(Image.open(io.BytesIO(response.data)).format,'WEBP')
        response.close()
        doc = copy.deepcopy(self.seed); doc['products'][0]['image']=result.json['url']
        self.assertEqual(self.save(doc).status_code,200)
        result = self.client.post('/api/admin/upload',data={'file':(io.BytesIO(b'<svg onload="alert(1)"></svg>'),'bad.svg')},headers=self.csrf)
        self.assertEqual(result.status_code,400)
        self.assertEqual(self.client.get('/uploads/cms.sqlite3').status_code,404)
        self.assertEqual(self.client.get('/.env').status_code,404)
        self.assertEqual(self.client.get('/server/app.py').status_code,404)

    def test_password_change_revokes_other_sessions_and_logout(self):
        self.login()
        other = cms.app.test_client()
        login = other.post('/api/login',json={'password':'local-test-password'},headers=self.origin)
        self.assertEqual(login.status_code,200)
        result = self.client.post('/api/password',json={'current':'local-test-password','password':'replacement-password'},headers=self.csrf)
        self.assertEqual(result.status_code,200)
        self.assertEqual(other.get('/api/admin/content').status_code,401)
        self.assertEqual(self.client.get('/api/admin/content').status_code,200)
        self.csrf['X-CSRF-Token'] = result.json['csrf']
        self.assertEqual(self.client.post('/api/logout',json={},headers=self.csrf).status_code,200)
        self.assertEqual(self.client.get('/api/admin/content').status_code,401)

    def test_login_throttling(self):
        for _ in range(8):
            self.assertEqual(self.client.post('/api/login',json={'password':'wrong'},headers=self.origin).status_code,403)
        self.assertEqual(self.client.post('/api/login',json={'password':'wrong'},headers=self.origin).status_code,429)

    def test_draft_does_not_block_save_and_published_error_identifies_card(self):
        self.login()
        doc = copy.deepcopy(self.seed)
        draft = {**doc['products'][0], 'id':'unfinished', 'name':'Черновик', 'detail':'', 'description':'', 'visible':False}
        doc['products'].insert(0, draft)
        self.assertEqual(self.save(doc).status_code,200)
        self.assertNotIn('unfinished', [p['id'] for p in self.client.get('/api/content').json['content']['products']])
        draft['visible'] = True
        response = self.save(doc, 2)
        self.assertEqual(response.status_code,400)
        self.assertEqual(response.json['itemId'],'unfinished')
        self.assertEqual(response.json['field'],'description')
        self.assertIn('Заполните',response.json['error'])
        self.assertNotIn('максимум',response.json['error'])
        draft['description'] = 'Серьги из холодного фарфора с добавлением гранатовой шпинели'
        self.assertEqual(self.save(doc,2).status_code,200)

    def test_galleries_entries_visibility_and_legacy_editor_preservation(self):
        self.login()
        doc = copy.deepcopy(self.seed)
        doc['products'][0]['images'] = ['/assets/bridal.webp','/assets/details.webp']
        doc['reviews'] = [dict(id='test-review',title='Отзыв',text='Подпись мастера',images=['/assets/look1.webp'],source='https://t.me/farfforija/3',visible=True),dict(id='private-review',title='Черновик',text='',images=[],source='',visible=False)]
        doc['events'] = [dict(id='test-event',title='Выставка',text='История',images=[],source='',date='2026-04-18',visible=True)]
        result = self.save(doc)
        self.assertEqual(result.status_code,200,result.json)
        public = self.client.get('/api/content').json['content']
        self.assertEqual(len(public['reviews']),1)
        self.assertEqual(public['products'][0]['images'][0],doc['products'][0]['image'])
        legacy = copy.deepcopy(doc)
        del legacy['reviews']; del legacy['events']; del legacy['products'][0]['images']
        result = self.save(legacy,2)
        self.assertEqual(result.status_code,200,result.json)
        self.assertEqual(result.json['content']['reviews'],doc['reviews'])
        self.assertEqual(result.json['content']['events'],doc['events'])
        self.assertIn('/assets/details.webp',result.json['content']['products'][0]['images'])
        doc['events'][0]['date']='2026-02-31'
        self.assertEqual(self.save(doc,3).status_code,400)
        doc['events'][0]['date']='2026-02-28'
        doc['reviews'][0]['images']=['/assets/../../server/app.py']
        self.assertEqual(self.save(doc,3).status_code,400)
        doc['reviews'][0]['images']=[]
        doc['reviews'][0]['source']='javascript:alert(1)'
        self.assertEqual(self.save(doc,3).status_code,400)

    def test_iphone_heic_reencoded_and_exif_removed(self):
        from pillow_heif import from_pillow
        self.login()
        picture=Image.new('RGB',(80,120),(180,140,160))
        stream=io.BytesIO(); from_pillow(picture).save(stream); stream.seek(0)
        result=self.client.post('/api/admin/upload',data={'file':(stream,'iphone.HEIC')},headers=self.csrf)
        self.assertEqual(result.status_code,201,result.json)
        response=self.client.get(result.json['url'])
        with Image.open(io.BytesIO(response.data)) as converted:
            self.assertEqual(converted.format,'WEBP')
            self.assertEqual(converted.size,(80,120))
            self.assertFalse(converted.getexif())
        response.close()

    def test_jpeg_with_mpf_uses_primary_photo_not_auxiliary_frame(self):
        self.login()
        photo = Image.new('RGB', (80, 120), (220, 30, 40))
        auxiliary = Image.new('RGB', (20, 30), (100, 100, 100))
        exif = Image.Exif(); exif[274] = 6
        stream = io.BytesIO()
        photo.save(stream, 'MPO', save_all=True, append_images=[auxiliary], exif=exif)
        payload = stream.getvalue()
        with Image.open(io.BytesIO(payload)) as decoded:
            self.assertEqual(decoded.format, 'MPO')
            self.assertEqual(decoded.n_frames, 2)
        result = self.client.post('/api/admin/upload', data={'file':(io.BytesIO(payload), 'IMG_6573.jpeg')}, headers=self.csrf)
        self.assertEqual(result.status_code, 201, result.json)
        response = self.client.get(result.json['url'])
        with Image.open(io.BytesIO(response.data)) as converted:
            self.assertEqual(converted.format, 'WEBP')
            self.assertEqual(converted.size, (120, 80))
            red, green, blue = converted.getpixel((60, 40))
            self.assertGreater(red, green + 100)
            self.assertFalse(converted.getexif())
            self.assertEqual(getattr(converted, 'n_frames', 1), 1)
        response.close()

    def test_unsupported_photo_reports_actual_format_not_filename(self):
        self.login()
        stream = io.BytesIO()
        Image.new('RGB', (20, 30)).save(stream, 'TIFF')
        stream.seek(0)
        result = self.client.post('/api/admin/upload', data={'file':(stream, 'renamed.jpeg')}, headers=self.csrf)
        self.assertEqual(result.status_code, 400)
        self.assertIn('TIFF', result.json['error'])


if __name__ == '__main__':
    unittest.main()
