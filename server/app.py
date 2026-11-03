"""Small, single-owner CMS. Persistent data lives outside the Git checkout."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
from functools import wraps
from urllib.parse import urlparse

from flask import Flask, abort, g, jsonify, request, send_from_directory
from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / 'public'
FIELDS = json.loads((PUBLIC / 'admin/fields.json').read_text(encoding='utf-8'))
DATA = Path(os.environ.get('MARKINA_DATA', ROOT / '.cms-data'))
ORIGIN = os.environ.get('MARKINA_ORIGIN', 'http://localhost:8320').rstrip('/')
SECURE = ORIGIN.startswith('https://')
COOKIE = 'markina_session'
Image.MAX_IMAGE_PIXELS = 24_000_000
register_heif_opener(thumbnails=False)
app = Flask(__name__, static_folder=None)
app.config['MAX_CONTENT_LENGTH'] = 13 * 1024 * 1024


class Database(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def connect():
    db = sqlite3.connect(DATA / 'cms.sqlite3', timeout=15, factory=Database)
    db.row_factory = sqlite3.Row
    return db


def initialize():
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / 'uploads').mkdir(exist_ok=True)
    with connect() as db:
        db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), password TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), document TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS setup (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS attempts (ip TEXT NOT NULL, created INTEGER NOT NULL);
        ''')
        if not db.execute('SELECT 1 FROM revisions LIMIT 1').fetchone():
            seed = json.loads((PUBLIC / 'content.json').read_text(encoding='utf-8'))
            db.execute('INSERT INTO revisions(document) VALUES (?)', (json.dumps(seed, ensure_ascii=False),))


initialize()


def fail(message, status=400, **details):
    try:
        abort(status, description=message)
    except HTTPException as error:
        error.details = details
        raise


@app.errorhandler(HTTPException)
def http_error(error):
    messages = {401: 'Войдите в админку заново.', 413: 'Файл слишком большой. Максимум 12 МБ.', 429: 'Слишком много попыток. Попробуйте через 15 минут.'}
    return jsonify(error=messages.get(error.code, error.description), **getattr(error, 'details', {})), error.code


@app.after_request
def headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'no-referrer'
    if request.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['Vary'] = 'Cookie'
    return response


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


@app.before_request
def protect():
    g.session = None
    if not request.path.startswith('/api/'):
        return
    token = request.cookies.get(COOKIE, '')
    if token:
        with connect() as db:
            g.session = db.execute('SELECT * FROM sessions WHERE token=? AND expires>?', (digest(token), int(time.time()))).fetchone()
    if request.method in ('POST', 'PUT', 'DELETE'):
        if request.headers.get('Origin') != ORIGIN:
            fail('Запрос отклонён. Откройте админку на основном адресе сайта.', 403)
        if request.path not in ('/api/login', '/api/setup'):
            if not g.session:
                abort(401)
            if not hmac.compare_digest(request.headers.get('X-CSRF-Token', ''), g.session['csrf']):
                fail('Обновите страницу и повторите сохранение.', 403)


def private(fn):
    @wraps(fn)
    def decorated(*args, **kwargs):
        if not g.session:
            abort(401)
        return fn(*args, **kwargs)
    return decorated


def body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        fail('Ожидается JSON объект.')
    return data


def limit_attempts(db):
    now = int(time.time())
    # Nginx overwrites X-Real-IP. The service only binds to loopback.
    ip = request.headers.get('X-Real-IP', request.remote_addr)
    db.execute('DELETE FROM attempts WHERE created<?', (now - 900,))
    own = db.execute('SELECT count(*) FROM attempts WHERE ip=?', (ip,)).fetchone()[0]
    total = db.execute('SELECT count(*) FROM attempts').fetchone()[0]
    if own >= 8 or total >= 80:
        abort(429)
    db.execute('INSERT INTO attempts VALUES (?,?)', (ip, now))
    db.commit()


def new_session(db):
    token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    db.execute('DELETE FROM sessions WHERE expires<?', (int(time.time()),))
    db.execute('INSERT INTO sessions VALUES (?,?,?)', (digest(token), csrf, int(time.time()) + 8 * 3600))
    response = jsonify(ok=True, csrf=csrf)
    response.set_cookie(COOKIE, token, max_age=8 * 3600, secure=SECURE, httponly=True, samesite='Strict', path='/api/')
    return response


@app.get('/api/session')
def session_status():
    with connect() as db:
        initialized = bool(db.execute('SELECT 1 FROM owner').fetchone())
    return jsonify(initialized=initialized, authenticated=bool(g.session), csrf=g.session['csrf'] if g.session else None)


@app.post('/api/setup')
def setup():
    data = body()
    password = password_value(data.get('password'))
    with connect() as db:
        limit_attempts(db)
        db.execute('BEGIN IMMEDIATE')
        proof = db.execute('SELECT * FROM setup WHERE expires>?', (int(time.time()),)).fetchone()
        exists = db.execute('SELECT 1 FROM owner').fetchone()
        if exists or not proof or not hmac.compare_digest(proof['token'], digest(str(data.get('token', '')))):
            fail('Ссылка настройки недействительна или уже использована.', 403)
        db.execute('INSERT INTO owner VALUES (1,?)', (generate_password_hash(password),))
        db.execute('DELETE FROM setup')
        return new_session(db)


@app.post('/api/login')
def login():
    data = body()
    password = data.get('password', '')
    if not isinstance(password, str) or len(password) > 256:
        fail('Неверный пароль.', 403)
    with connect() as db:
        limit_attempts(db)
        owner = db.execute('SELECT password FROM owner WHERE id=1').fetchone()
        # Use the same expensive check even before setup, to avoid a fast guess path.
        hashed = owner['password'] if owner else generate_password_hash(secrets.token_urlsafe(32))
        if not check_password_hash(hashed, password) or not owner:
            fail('Неверный пароль.', 403)
        return new_session(db)


@app.post('/api/logout')
@private
def logout():
    with connect() as db:
        db.execute('DELETE FROM sessions WHERE token=?', (g.session['token'],))
    response = jsonify(ok=True)
    response.delete_cookie(COOKIE, path='/api/', secure=SECURE, httponly=True, samesite='Strict')
    return response


def password_value(value):
    if not isinstance(value, str) or len(value) < 12 or len(value) > 256:
        fail('Пароль должен содержать от 12 до 256 символов.')
    return value


@app.post('/api/password')
@private
def change_password():
    data = body()
    password = password_value(data.get('password'))
    with connect() as db:
        limit_attempts(db)
        owner = db.execute('SELECT password FROM owner WHERE id=1').fetchone()
        if not check_password_hash(owner['password'], str(data.get('current', ''))[:256]):
            fail('Текущий пароль не подошёл.', 403)
        db.execute('UPDATE owner SET password=? WHERE id=1', (generate_password_hash(password),))
        db.execute('DELETE FROM sessions')
        return new_session(db)


def latest(db):
    row = db.execute('SELECT * FROM revisions ORDER BY id DESC LIMIT 1').fetchone()
    return dict(revision=row['id'], updated=row['created'], content=json.loads(row['document']))


@app.get('/api/content')
def public_content():
    with connect() as db:
        data = latest(db)
    data['content']['products'] = [p for p in data['content']['products'] if p['visible']]
    for key in ('reviews', 'events'):
        data['content'][key] = [p for p in data['content'].get(key, []) if p.get('visible')]
    return jsonify(data)


@app.get('/api/admin/content')
@private
def admin_content():
    with connect() as db:
        return jsonify(latest(db))


def string(value, label, maximum=5000, required=True):
    if not isinstance(value, str):
        fail(f'Заполните поле «{label}» текстом.')
    if required and not value.strip():
        fail(f'Заполните поле «{label}».')
    if len(value) > maximum:
        fail(f'В поле «{label}» больше {maximum} символов. Сократите текст.')
    return value.strip()


def url(value, label, optional=False):
    value = string(value, label, 1000, not optional)
    if not value and optional:
        return ''
    try:
        parsed = urlparse(value)
        valid = parsed.scheme == 'https' and parsed.hostname and parsed.port != 0 and not parsed.username and not parsed.password and not any(c.isspace() or ord(c) < 32 for c in value)
    except ValueError:
        valid = False
    if not valid:
        fail(f'В поле «{label}» нужна ссылка, начинающаяся с https://.')
    return value


def image_url(value):
    value = string(value, 'Фотография', 150)
    if re.fullmatch(r'/assets/[a-z0-9-]+\.(?:webp|png|jpg|jpeg)', value):
        if (PUBLIC / value.lstrip('/')).is_file():
            return value
    if re.fullmatch(r'/uploads/[a-f0-9]{32}\.webp', value):
        if (DATA / value.lstrip('/')).is_file():
            return value
    fail('Выберите фотографию из библиотеки или загрузите новую.')


def image_list(value, cover=None):
    if not isinstance(value, list) or len(value) > 20:
        fail('Можно добавить до 20 фотографий.')
    result = list(dict.fromkeys(image_url(item) for item in value))
    if cover:
        result = [cover] + [item for item in result if item != cover]
    if len(result) > 20:
        fail('Можно добавить до 20 фотографий.')
    return result


def validate_content(data):
    if not isinstance(data, dict):
        fail('Содержимое сайта не найдено.')
    sections = data.get('sections')
    if not isinstance(sections, dict):
        fail('Разделы сайта не найдены.')
    clean = {'sections': {}, 'products': [], 'faq': [], 'steps': [], 'stories': []}
    for f in FIELDS:
        value = sections.get(f['id'])
        if f['type'] == 'image':
            value = image_url(value)
        elif f['type'] == 'url':
            value = url(value, f['label'])
        elif f['type'] == 'phone':
            value = string(value, 'Телефон', 25)
            if not re.fullmatch(r'\+?[0-9 ()-]{5,25}', value):
                fail('Проверьте номер телефона.')
        else:
            value = string(value, f['label'])
        clean['sections'][f['id']] = value
    products = data.get('products')
    if not isinstance(products, list) or len(products) > 300:
        fail('В галерее может быть до 300 карточек.')
    ids = set()
    for p in products:
        if not isinstance(p, dict):
            fail('Некорректная карточка.')
        key = string(p.get('id'), 'ID', 80)
        if not re.fullmatch(r'[a-z0-9-]+', key) or key in ids:
            fail('Повторяющийся или некорректный ID карточки.')
        ids.add(key)
        types = p.get('types')
        if not isinstance(types, list) or not types or len(types) > 3 or any(t not in ('earrings', 'pendants', 'wedding') for t in types):
            fail('Выберите хотя бы одну подборку для карточки.')
        if not isinstance(p.get('visible'), bool):
            fail('Проверьте видимость карточки.')
        row = dict(id=key, types=list(dict.fromkeys(types)), visible=p['visible'])
        for field, label, maximum, required in [('name', 'Название', 150, True), ('category', 'Категория', 80, True), ('detail', 'Короткая подпись', 250, False), ('description', 'Описание', 5000, p['visible'])]:
            try:
                row[field] = string(p.get(field, ''), label, maximum, required)
            except HTTPException as error:
                error.description = f'Карточка «{str(p.get("name", "Без названия"))[:150]}»: {error.description}'
                error.details = dict(section='products', itemId=key, field=field)
                raise
        row['image'] = image_url(p.get('image'))
        row['images'] = image_list(p.get('images', []), row['image'])
        row['source'] = url(p.get('source'), 'Публикация', True)
        clean['products'].append(row)
    for collection in ('reviews', 'events'):
        items = data.get(collection, [])
        if not isinstance(items, list) or len(items) > 100:
            fail('В разделе может быть до 100 записей.')
        clean[collection] = []
        used = set()
        for item in items:
            if not isinstance(item, dict):
                fail('Некорректная запись раздела.')
            key = string(item.get('id'), 'ID', 80)
            if not re.fullmatch(r'[a-z0-9-]+', key) or key in used:
                fail('Повторяющийся или некорректный ID записи.')
            used.add(key)
            if not isinstance(item.get('visible'), bool):
                fail('Проверьте видимость записи.')
            try:
                row = dict(id=key, title=string(item.get('title'), 'Заголовок', 150), text=string(item.get('text', ''), 'Текст', 10000, False), images=image_list(item.get('images', [])), source=url(item.get('source', ''), 'Публикация', True), visible=item['visible'])
                if item['visible'] and not row['images'] and not row['text']:
                    fail('Добавьте фотографию или текст перед публикацией.')
                if collection == 'events':
                    date = string(item.get('date', ''), 'Дата', 10, False)
                    if date:
                        from datetime import date as calendar_date
                        try:
                            calendar_date.fromisoformat(date)
                        except ValueError:
                            fail('Укажите дату в формате ГГГГ-ММ-ДД.')
                    row['date'] = date
            except HTTPException as error:
                error.description = f'Запись «{str(item.get("title", "Без названия"))[:150]}»: {error.description}'
                error.details = dict(section=collection, itemId=key)
                raise
            clean[collection].append(row)
    for key, count, keys in [('faq', 30, ('question', 'answer')), ('steps', 3, ('title', 'text')), ('stories', 3, ('name', 'image', 'detailImage', 'source'))]:
        items = data.get(key)
        if not isinstance(items, list) or not 1 <= len(items) <= count or (key != 'faq' and len(items) != count):
            fail(f'Проверьте список {key}.')
        for item in items:
            if not isinstance(item, dict):
                fail('Некорректный элемент раздела.')
            row = {}
            for k in keys:
                value = item.get(k)
                row[k] = image_url(value) if k in ('image', 'detailImage') else url(value, 'Публикация') if k == 'source' else string(value, k)
            clean[key].append(row)
    return clean


@app.put('/api/admin/content')
@private
def save_content():
    data = body()
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        current = latest(db)
        if current['revision'] != data.get('revision'):
            fail('Кто-то уже изменил сайт. Скачайте свою копию, затем обновите страницу перед повторным редактированием.', 409)
        document = data.get('content')
        # An older open admin tab must not silently erase the added galleries.
        if isinstance(document, dict):
            for key in ('reviews', 'events'):
                document.setdefault(key, current['content'].get(key, []))
            previous = {p['id']: p for p in current['content']['products']}
            for product in document.get('products', []) if isinstance(document.get('products'), list) else []:
                if isinstance(product, dict) and 'images' not in product:
                    product['images'] = previous.get(product.get('id'), {}).get('images', [])
        content = validate_content(document)
        db.execute('INSERT INTO revisions(document) VALUES (?)', (json.dumps(content, ensure_ascii=False),))
        db.execute('DELETE FROM revisions WHERE id NOT IN (SELECT id FROM revisions ORDER BY id DESC LIMIT 100)')
        return jsonify(latest(db))


@app.get('/api/admin/history')
@private
def history():
    with connect() as db:
        rows = db.execute('SELECT id,created FROM revisions ORDER BY id DESC LIMIT 100').fetchall()
    return jsonify([dict(revision=r['id'], updated=r['created']) for r in rows])


@app.get('/api/admin/history/<int:revision>')
@private
def history_content(revision):
    with connect() as db:
        row = db.execute('SELECT document FROM revisions WHERE id=?', (revision,)).fetchone()
    if not row:
        abort(404)
    return jsonify(content=json.loads(row['document']))


@app.get('/api/admin/media')
@private
def media():
    assets = ['/assets/' + p.name for p in (PUBLIC / 'assets').glob('*.webp')]
    uploads = ['/uploads/' + p.name for p in sorted((DATA / 'uploads').glob('*.webp'), key=lambda p: p.stat().st_mtime, reverse=True)]
    return jsonify(uploads + sorted(assets))


@app.post('/api/admin/upload')
@private
def upload():
    file = request.files.get('file')
    if not file:
        fail('Выберите JPEG, PNG, WebP или HEIC с iPhone.')
    file.stream.seek(0, 2)
    if file.stream.tell() > 12 * 1024 * 1024:
        fail('Файл слишком большой. Максимум 12 МБ.', 413)
    file.stream.seek(0)
    try:
        with Image.open(file.stream) as source:
            if source.format not in ('JPEG', 'PNG', 'WEBP', 'HEIF'):
                fail('Поддерживаются JPEG, PNG, WebP и HEIC/HEIF.')
            if source.width * source.height > Image.MAX_IMAGE_PIXELS:
                fail('Фотография слишком большая. Максимум 24 мегапикселя.')
            picture = ImageOps.exif_transpose(source)
            picture.thumbnail((2400, 2400))
            picture = picture.convert('RGBA' if 'A' in picture.getbands() else 'RGB')
            name = secrets.token_hex(16) + '.webp'
            picture.save(DATA / 'uploads' / name, 'WEBP', quality=88)
    except (UnidentifiedImageError, OSError, ValueError, RuntimeError, Image.DecompressionBombError):
        fail('Не удалось прочитать фотографию. Попробуйте другой JPEG, PNG, WebP или HEIC.')
    return jsonify(url='/uploads/' + name), 201


@app.get('/uploads/<name>')
def uploaded(name):
    if not re.fullmatch(r'[a-f0-9]{32}\.webp', name):
        abort(404)
    return send_from_directory(DATA / 'uploads', name, max_age=31536000)


# Local preview only; production Nginx serves these files directly.
@app.get('/')
def home():
    return send_from_directory(PUBLIC, 'index.html')


@app.get('/<path:name>')
def preview_file(name):
    if any(part.startswith('.') for part in name.split('/')):
        abort(404)
    if name.endswith('/'):
        name += 'index.html'
    return send_from_directory(PUBLIC, name)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['serve', 'setup-link', 'reset-password'], nargs='?', default='serve')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.command == 'serve':
        app.run(host='127.0.0.1', port=int(os.environ.get('PORT', 8320)), threaded=True)
    elif args.command == 'setup-link':
        if not args.output:
            parser.error('--output is required; the token is never printed')
        with connect() as db:
            if db.execute('SELECT 1 FROM owner').fetchone():
                raise SystemExit('Owner already exists. Use reset-password interactively.')
            token = secrets.token_urlsafe(32)
            db.execute('INSERT OR REPLACE INTO setup VALUES (1,?,?)', (digest(token), int(time.time()) + 86400))
        args.output.write_text(ORIGIN + '/admin/#setup=' + token, encoding='utf-8')
        args.output.chmod(0o600)
        print('One-time setup link written. Expires in 24 hours.')
    else:
        import getpass
        password = password_value(getpass.getpass('New password (12+ characters): '))
        if password != getpass.getpass('Repeat password: '):
            raise SystemExit('Passwords differ.')
        with connect() as db:
            db.execute('INSERT OR REPLACE INTO owner VALUES (1,?)', (generate_password_hash(password),))
            db.execute('DELETE FROM sessions')
            db.execute('DELETE FROM setup')
        print('Password changed. All sessions revoked.')
