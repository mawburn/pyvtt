#!/usr/bin/python3 
# -*- coding: utf-8 -*- 
"""
https://github.com/cgloeckner/pyvtt/

Copyright (c) 2020-2021 Christian Glöckner
License: MIT (see LICENSE for details)
"""

from gevent import monkey; monkey.patch_all()
import gevent

import os, json, time, sys, random, subprocess, requests, flag

from pony import orm
from bottle import *

from engine import Engine
from cache import PlayerCache


__author__ = 'Christian Glöckner'
__licence__ = 'MIT'


def setup_gm_routes(engine):

    # shared login page
    @get('/vtt/join')
    @view('join')
    def gm_login():
        return dict(engine=engine)

    # login callback
    @get('/vtt/callback')
    def gm_login_callback():
        # query session from login auth
        session = engine.login_api.getSession(request)
        
        if not session['granted']:
            # not allowed, just redirect that poor soul
            redirect('/vtt/join')
        
        # test whether GM is already there
        gm = engine.main_db.GM.select(lambda g: g.url == session['user']['id']).first()
        if gm is None:
            # create GM (username as display name, user-id as url)
            gm = engine.main_db.GM(
                name=session['user']['username'],
                url=str(session['user']['id']),
                sid=session['sid']
            )
            gm.postSetup()
            engine.main_db.commit()
            
            # add to cache and initialize database
            engine.cache.insert(gm)
            gm_cache = engine.cache.get(gm)
            
            # @NOTE: database creation NEEDS to be run from another
            # thread, because every bottle route has an db_session
            # active, but creating a database from within a db_session
            # isn't possible
            tmp = gevent.Greenlet(run=gm_cache.connect_db)
            tmp.start()
            try:
                tmp.get()
            except:
                # reraise greenlet's exception to trigger proper error reporting
                raise
            
            engine.logging.access('GM created using external auth with name="{0}" url={1} by {2}.'.format(gm.name, gm.url, engine.getClientIp(request)))
            
        else:
            # create new session for already existing GM
            gm.sid = session['sid']
            # update GM name
            gm.name = session['user']['username']
            
        gm.refreshSession(response)
        
        engine.logging.access('GM name="{0}" url={1} session refreshed using external auth by {2}'.format(gm.name, gm.url, engine.getClientIp(request)))
        
        engine.main_db.commit()
        # redirect to GM's game overview
        redirect('/')
    
    # non-auth login
    @post('/vtt/join')
    def post_gm_login():
        if engine.login['type'] != '':
            abort(404)
        
        status = {
            'url'   : None,
            'error' : ''
        }
        
        # test gm name (also as url)
        gmname = request.forms.gmname
        if not engine.verifyUrlSection(gmname):
            # contains invalid characters   
            status['error'] = 'NO SPECIAL CHARS OR SPACES'
            engine.logging.warning('Failed GM login by {0}: invalid name "{1}".'.format(engine.getClientIp(request), gmname))
            return status
            
        name = gmname[:20].lower().strip()
        if name in engine.gm_blacklist:
            # blacklisted name
            status['error'] = 'RESERVED NAME'  
            engine.logging.warning('Failed GM login by {0}: reserved name "{1}".'.format(engine.getClientIp(request), gmname))
            return status
            
        if len(engine.main_db.GM.select(lambda g: g.name == name or g.url == name)) > 0:
            # collision
            status['error'] = 'ALREADY IN USE'   
            engine.logging.warning('Failed GM login by {0}: name collision "{1}".'.format(engine.getClientIp(request), gmname))
            return status
        
        # create new GM (use GM name as display name and URL)
        sid = engine.main_db.GM.genSession()
        gm = engine.main_db.GM(name=name, url=name, sid=sid)
        gm.postSetup()
        engine.main_db.commit()
        
        # add to cache and initialize database
        engine.cache.insert(gm)
        gm_cache = engine.cache.get(gm)
        
        # @NOTE: database creation NEEDS to be run from another
        # thread, because every bottle route has an db_session
        # active, but creating a database from within a db_session
        # isn't possible
        tmp = gevent.Greenlet(run=gm_cache.connect_db)
        tmp.start()
        try:
            tmp.get()
        except:
            # reraise greenlet's exception to trigger proper error reporting
            raise
        
        expires = time.time() + engine.expire
        response.set_cookie('session', sid, path='/', expires=expires, secure=engine.hasSsl())
        
        engine.logging.access('GM created with name="{0}" url={1} by {2}.'.format(gm.name, gm.url, engine.getClientIp(request)))
        
        engine.main_db.commit()
        status['url'] = gm.url
        return status

    @get('/vtt/logout')
    def vtt_logout():  
        url = engine.login_api.getLogoutUrl()
        # remove cookie
        response.set_cookie('session', '', path='/', max_age=1, secure=engine.hasSsl())
        # redirect to external logout
        redirect(url)

    @get('/')
    @view('gm')
    def get_game_list():
        gm = engine.main_db.GM.loadFromSession(request)
        if gm is None:
            # remove cookie
            response.set_cookie('session', '', path='/', max_age=1, secure=engine.hasSsl())
            # redirect to login screen
            redirect('/vtt/join')
        
        # load GM from cache
        gm_cache = engine.cache.get(gm)
        if gm_cache is None:
            # remove cookie
            engine.logging.warning('GM name="{0}" url={1} tried to relogin by {2} but he was not in the cache'.format(gm.name, gm.url, engine.getClientIp(request)))
            response.set_cookie('session', '', path='/', max_age=1, secure=engine.hasSsl())
            abort(404)
        
        # refresh session
        gm.refreshSession(response)
        
        engine.logging.access('GM name="{0}" url={1} session refreshed by {2}'.format(gm.name, gm.url, engine.getClientIp(request)))
        
        server = ''
        if engine.local_gm:
            server = engine.getUrl()
        
        # load game from GM's database
        all_games = gm_cache.db.Game.select()
        
        # show GM's games
        return dict(engine=engine, gm=gm, all_games=all_games, server=server)

    @get('/vtt/fancy-url')
    def call_fancy_url():
        return engine.url_generator()

    @post('/vtt/import-game/')
    @post('/vtt/import-game/<url>')
    def post_import_game(url=None):
        status = {
            'url_ok'  : False,
            'file_ok' : False,
            'error'   : '',
            'url'     : ''
        }
        
        # check GM
        gm = engine.main_db.GM.loadFromSession(request) 
        if gm is None:
            abort(404)
           
        # load GM from cache
        gm_cache = engine.cache.get(gm)
        
        if url is None:
            # pick random nonsense
            # @NOTE: the set of possible URLs is huge. we just play with
            # not having a collision, else the game creation would fail
            # and an error would be reported anyway
            url = engine.url_generator()
            
        else:
            # trim url length, convert to lowercase and trim whitespaces
            url = url[:30].lower().strip()
            
            # url
            if not engine.verifyUrlSection(url):
                engine.logging.warning('GM name="{0}" url={1} tried to import game by {2} but game url "{3}" is invalid'.format(gm.name, gm.url, engine.getClientIp(request), url))
                status['error'] = 'NO SPECIAL CHARS OR SPACES'
                return status
            
            if gm_cache.db.Game.select(lambda g: g.url == url).first() is not None:
                engine.logging.warning('GM name="{0}" url={1} tried to import game by {2} but game url "{3}" already in use'.format(gm.name, gm.url, engine.getClientIp(request), url))
                status['error'] = 'ALREADY IN USE'
                return status
        
        status['url_ok'] = True
        
        # upload file
        try:
            files = request.files.getall('file')
        except OSError:
            # cannot read uploaded files
            abort(404)
            
        if len(files) != 1:
            engine.logging.warning('GM name="{0}" url={1} tried to import game by {2} but uploaded {3} files'.format(gm.name, gm.url, engine.getClientIp(request), len(files)))
            status['error'] = 'ONE FILE AT ONCE'
            return status
        
        # query filesize
        size = engine.getSize(files[0])
        
        fname = files[0].filename
        is_zip = fname.endswith('zip')
        if is_zip:
            # test zip file size
            limit = engine.file_limit['game']
            if size <= limit * 1024 * 1024:
                game = gm_cache.db.Game.fromZip(gm, url, files[0])
                if game is None:
                    engine.logging.access('GM name="{0}" url={1} tried to import game by {2} but the ZIP was invalid'.format(gm.name, gm.url, engine.getClientIp(request), url))
                    status['error'] = 'CORRUPTED FILE'.format(limit)
                    return status
            else:
                engine.logging.warning('GM name="{0}" url={1} tried to import game by {2} but tried to cheat on the filesize'.format(gm.name, gm.url, engine.getClientIp(request), url))
                status['error'] = 'TOO LARGE GAME (MAX {0} MiB)'.format(limit)
                return status
        else:
            # test background file size
            limit = engine.file_limit['background']
            if size <= limit * 1024 * 1024:
                game = gm_cache.db.Game.fromImage(gm, url, files[0])
            else:   
                engine.logging.warning('GM name="{0}" url={1} tried to import game by {2} but tried to cheat on the filesize'.format(gm.name, gm.url, engine.getClientIp(request), url))
                status['error'] = 'TOO LARGE BACKGROUND (MAX {0} MiB)'.format(limit)
                return status
        
        status['file_ok'] = game is not None
        if not status['file_ok']:
            engine.logging.warning('GM name="{0}" url={1} tried to import game by {2} but uploaded neither an image nor a zip file'.format(gm.name, gm.url, engine.getClientIp(request), url))
            status['error'] = 'USE AN IMAGE FILE'
            return status
        
        if is_zip:
            engine.logging.access('Game {0} imported from "{1}" by {2}'.format(game.getUrl(), fname, engine.getClientIp(request)))
        else:
            engine.logging.access('Game {0} created from "{1}" by {2}'.format(game.getUrl(), fname, engine.getClientIp(request)))
        
        status['url'] = f'game/{game.getUrl()}';
        
        return status

    @get('/vtt/export-game/<url>')
    def export_game(url):
        gm = engine.main_db.GM.loadFromSession(request)
        if gm is None:
            abort(404)
        
        # load GM from cache
        gm_cache = engine.cache.get(gm)
        if gm_cache is None:
            engine.logging.warning('GM name="{0}" url="{1}" tried to export game {2} by {3} but he was not inside the cache'.format(gm.name, gm.url, url, engine.getClientIp(request)))
            abort(404)
        
        # load game from GM's database
        game = gm_cache.db.Game.select(lambda g: g.url == url).first()
        if game is None:
            engine.logging.warning('GM name="{0}" url="{1}" tried to export game {2} by {3} but game was not found'.format(gm.name, gm.url, url, engine.getClientIp(request)))
            abort(404)
        
        # export game to zip-file
        zip_file, zip_path = game.toZip()
         
        engine.logging.access('Game {0} exported by {1}'.format(game.getUrl(), engine.getClientIp(request)))
        
        # offer file for downloading
        return static_file(zip_file, root=zip_path, download=zip_file, mimetype='application/zip')

    @post('/vtt/clean-up/<url>')
    def clean_up(url):
        gm = engine.main_db.GM.loadFromSession(request)
        if gm is None:
            abort(404)
        
        # load GM from cache
        gm_cache = engine.cache.get(gm)
        if gm_cache is None:
            engine.logging.warning('GM name="{0}" url="{1}" tried to kick all players at {2} by {3} but he was not inside the cache'.format(gm.name, gm.url, url, engine.getClientIp(request)))
            abort(404)
        
        # load game from GM's database
        game = gm_cache.db.Game.select(lambda g: g.url == url).first()
        if game is None:
            engine.logging.warning('GM name="{0}" url="{1}" tried to kick all players at {2} by {3} but game was not found'.format(gm.name, gm.url, url, engine.getClientIp(request)))
            abort(404)
        
        # load game from cache and clean it up
        now = time.time()
        game_cache = gm_cache.get(game)
        game.cleanup(now) # cleanup old images and tokens
        game_cache.cleanup() # remove all players
        
        engine.logging.access('Players kicked from {0} by {1}'.format(game.getUrl(), engine.getClientIp(request)))

    @post('/vtt/kick-player/<url>/<uuid>')
    def kick_player(url, uuid):
        gm = engine.main_db.GM.loadFromSession(request)
        if gm is None:
            abort(404)
        
        # load GM from cache
        gm_cache = engine.cache.get(gm)
        if gm_cache is None:
            engine.logging.warning('GM name="{0}" url="{1}" tried to kick player #{4} at {2} by {3} but he was not inside the cache'.format(gm.name, gm.url, url, engine.getClientIp(request), uuid))
            abort(404)
        
        # load game from GM's database
        game = gm_cache.db.Game.select(lambda g: g.url == url).first()
        if game is None:
            engine.logging.warning('GM name="{0}" url="{1}" tried to kick players #{4} {2} by {3} but game was not found'.format(gm.name, gm.url, url, engine.getClientIp(request), uuid))
            abort(404)
        
        # fetch game cache and close sockets
        game_cache = gm_cache.get(game)
        if game_cache is None:
            engine.logging.warning('GM name="{0}" url="{1}" tried to kick player #{4} at {2} by {3} but the game was not inside the cache'.format(gm.name, gm.url, url, engine.getClientIp(request), uuid))
            abort(404)
        
        name = game_cache.disconnect(uuid)
        
        engine.logging.access('Player {0} ({1}) kicked from {2} by {3}'.format(name, uuid, game.getUrl(), engine.getClientIp(request)))

    @post('/vtt/delete-game/<url>')
    @view('games')
    def delete_game(url):
        gm = engine.main_db.GM.loadFromSession(request)
        if gm is None:
            abort(404)
        
        # load GM from cache
        gm_cache = engine.cache.get(gm)
        if gm_cache is None:
            engine.logging.warning('GM name="{0}" url="{1}" tried delete the game {2} by {3} but he was not inside the cache'.format(gm.name, gm.url, url, engine.getClientIp(request)))
            abort(404)
        
        # load game from GM's database
        game = gm_cache.db.Game.select(lambda g: g.url == url).first()
        if game is None:
            engine.logging.warning('GM name="{0}" url="{1}" tried delete the game {2} by {3} but game was not found'.format(gm.name, gm.url, url, engine.getClientIp(request)))
            abort(404)
        
        # delete everything for that game
        game.preDelete()
        game.delete()
        
        engine.logging.access('Game {0} deleted by {1}'.format(game.getUrl(), engine.getClientIp(request)))
        
        # load game from GM's database
        all_games = gm_cache.db.Game.select()
        
        server = ''
        if engine.local_gm:
            server = engine.getUrl()
        
        return dict(gm=gm, server=server, all_games=all_games)
    
    @post('/vtt/hashtest/<gmurl>/<url>')
    def post_image_hashtest(gmurl, url):
        # load GM from cache
        gm_cache = engine.cache.getFromUrl(gmurl)
        if gm_cache is None:
            abort(404)

        # loda game from cache
        game_cache = gm_cache.getFromUrl(url)
        if game_cache is None:
            abort(404)
        
        # load game from GM's database to upload files
        game = gm_cache.db.Game.select(lambda g: g.url == url).first()
        if game is None:  
            abort(404)

        # query urls for given md5 hashes
        known_urls = list()
        for md5 in request.forms.getall('hashs[]'):
            if md5 is not None:
                imgid = game.getIdByMd5(md5)
            
                if imgid is not None:
                    url = game.getImageUrl(imgid)
                    known_urls.append(url)

        return {'urls': known_urls}

    @post('/vtt/upload-background/<gmurl>/<url>')
    def post_set_background(gmurl, url):
        gm = engine.main_db.GM.loadFromSession(request)
        if gm is None:
            engine.logging.warning('GM url="{0}" tried set the background at the game {1} by {2} but is not the GM'.format(gmurl, url, engine.getClientIp(request)))
            abort(404)
        
        # load GM from cache
        gm_cache = engine.cache.get(gm)
        if gm_cache is None:
            engine.logging.warning('GM name="{0}" url="{1}" tried set the background at the game {2} by {3} but he was not inside the cache'.format(gm.name, gm.url, url, engine.getClientIp(request)))
            abort(404)
        
        # load game from GM's database
        game = gm_cache.db.Game.select(lambda g: g.url == url).first()
        if game is None:
            engine.logging.warning('GM name="{0}" url="{1}" tried set the background at the game {2} by {3} but game was not found'.format(gm.name, gm.url, url, engine.getClientIp(request)))
            abort(404)

        # load scene
        scene = gm_cache.db.Scene.select(lambda s: s.id == game.active).first()
        if scene is None:
            abort(404)

        # expect single background to be uploaded
        try:
            files = request.files.getall('file[]')
        except OSError:
            # cannot read uploaded files
            abort(404)
        
        if len(files) != 1:
            engine.logging.warning('GM name="{0}" url="{1}" tried set the background at the game {2} by {3} but did not provide a single image'.format(gm.name, gm.url, url, engine.getClientIp(request)))
            abort(403) # Forbidden

        # check mime type
        handle  = files[0]
        content = handle.content_type.split('/')[0]
        if content != 'image':            
            engine.logging.warning('GM name="{0}" url="{1}" tried set the background at the game {2} by {3} but used an unsupported type'.format(gm.name, gm.url, url, engine.getClientIp(request)))
            abort(403) # Forbidden

        # check file size
        max_filesize = engine.file_limit['background']
        size = engine.getSize(handle)
        if size > max_filesize * 1024 * 1024:      
            engine.logging.warning('GM name="{0}" url="{1}" tried set the background at the game {2} by {3} but file was too large'.format(gm.name, gm.url, url, engine.getClientIp(request)))
            abort(403) # Forbidden

        # upload image
        img_url = game.upload(handle)
        return img_url

    @post('/vtt/query-scenes/<url>')
    @view('scenes')
    def post_create_scene(url):
        gm = engine.main_db.GM.loadFromSession(request)
        if gm is None:
            abort(404)
        
        # load GM from cache
        gm_cache = engine.cache.get(gm)
        if gm_cache is None:
            engine.logging.warning('GM name="{0}" url="{1}" tried create a scene at game {2} by {3} but he was not inside the cache'.format(gm.name, gm.url, url, engine.getClientIp(request)))
            abort(404)
        
        # load game from GM's database
        game = gm_cache.db.Game.select(lambda g: g.url == url).first()
        if game is None:
            engine.logging.warning('GM name="{0}" url="{1}" tried create a scene at game {2} by {3} but game was not found'.format(gm.name, gm.url, url, engine.getClientIp(request)))
            abort(404)
        
        return dict(engine=engine, game=game)
    
    @get('/vtt/api/users')
    def api_query_users():
        now = time.time()

        # query gms
        total_gms     = engine.main_db.GM.select().count()
        abandoned_gms = engine.main_db.GM.select(lambda g: g.timeid < now - engine.expire).count()

        # query games
        threshold     = 10
        total_games   = 0
        running_games = 0
        with engine.cache.lock:
            for gm in engine.cache.gms:
                gm_cache = engine.cache.gms[gm]
                with gm_cache.lock:
                    total_games   += gm_cache.db.Game.select().count()
                    running_games += gm_cache.db.Game.select(lambda g: g.timeid >= now - threshold * 60).count()
        done = time.time()

        # return data
        return {
            'gms': {
                'total': total_gms,
                'abandoned': abandoned_gms
            },
            'games': {
                'total': total_games,
                'running': running_games
            },
            'query_time': done-now
        }

    @get('/vtt/api/games-list/<gmurl>')
    def api_games_list(gmurl):
        start = time.time()
        
        # load GM from cache
        gm_cache = engine.cache.getFromUrl(gmurl)
        if gm_cache is None:
            # @NOTE: not logged because somebody may play around with this
            abort(404)

        data = {
            'games': []
        }
        for game in gm_cache.db.Game.select():
            data['games'].append(game.url)
        done = time.time()

        data['query_time'] = done - start
        return data

    @get('/vtt/api/assets-list/<gmurl>/<url>')
    def api_asset_list(gmurl, url):
        start = time.time()
        
        # load GM from cache
        gm_cache = engine.cache.getFromUrl(gmurl)
        if gm_cache is None:
            # @NOTE: not logged because somebody may play around with this
            abort(404)
        
        # load game from GM's database
        game = gm_cache.db.Game.select(lambda g: g.url == url).first()
        if game is None:
            # @NOTE: not logged because somebody may play around with this
            abort(404)
        
        root = engine.paths.getGamePath(gmurl, url)
        files = {
            'images': [],
            'audio': []
        }
        for fname in os.listdir(root):
            if fname.endswith('.png'):
                files['images'].append(fname)
            if fname.endswith('.mp3'):
                files['audio'].append(fname)
        files['images'].sort(key=lambda k: int(k.split('.')[0]))
        files['audio'].sort()
        done = time.time()

        files['query_time'] = done-start

        return files

    @get('/vtt/api/logins')
    def api_query_logins():
        """Count users locations based on IPs within past 30d."""
        start = time.time()
        
        logins    = engine.parseLoginLog()
        locations  = dict()
        since = start - 30 * 24 * 3600 # past 30d

        # group IPs by country
        for record in logins:
            if record.timeid < since:
                continue
            if record.country not in locations:
                locations[record.country] = set()
            locations[record.country].add(record.ip)

        # count IPs per country
        for key in locations:
            locations[key] = len(locations[key])
        
        done = time.time()

        return {
            'locations': locations,
            'query_time': done-start
        }
    
    if engine.login['type'] == 'auth0':
        @get('/vtt/api/auth0')
        def api_query_auth0():
            # query gms and how many accounts do idle
            now   = time.time()
            total = 0
            provider = {}
            for gm in engine.main_db.GM.select():
                print(gm.url)
                p = engine.login_api.parseProvider(gm.url)
                if p not in provider:
                    provider[p] = 0
                provider[p] += 1
            done = time.time()

            provider['query_time'] = done-now
            return provider

    @get('/vtt/query/<index:int>')
    def status_query(index):
        if len(engine.shards) == 0:
            abort(404)
        
        # ask server
        try:
            host = engine.shards[index]
        except IndexError:
            abort(404)
        
        data = dict()   
        data['countryCode'] = None
        data['status']      = None   
        data['flag']        = None
        
        # query server location (if possible)
        ip      = host.split('://')[1].split(':')[0]
        country = engine.getCountryFromIp(ip)
        data['flag'] = flag.flag(country) if country not in ['?', 'unknown'] else ''
        
        # query server status
        try:
            html = requests.get(host + '/vtt/api/users', timeout=3)
            data['status'] = html.text;
        except requests.exceptions.ReadTimeout as e:
            engine.logging.error('Server {0} seems to be offline'.format(host))
        except requests.exceptions.ConnectionError as e:
            engine.logging.error('Server {0} seems to be offline'.format(host))
        
        return data

    @get('/vtt/shard')
    @view('shard')
    def shard_list():
        if len(engine.shards) == 0:
            abort(404)
        
        return dict(engine=engine, own=engine.getUrl())


# ---------------------------------------------------------------------

def setup_resource_routes(engine):
    
    @get('/static/<fname>')
    def static_files(fname):
        root = engine.paths.getStaticPath()
        if not os.path.isdir(root) or not os.path.exists(root / fname):
            root = './static'

        # @NOTE: no need to check file extension, this directory is
        # meant to be accessable as a whole

        return static_file(fname, root=root)

    @get('/asset/<gmurl>/<url>/<fname>')
    def game_asset(gmurl, url, fname):
        # load GM from cache
        gm_cache = engine.cache.getFromUrl(gmurl)
        if gm_cache is None:
            # @NOTE: not logged because somebody may play around with this
            abort(404)
        
        # load game from GM's database
        game = gm_cache.db.Game.select(lambda g: g.url == url).first()
        if game is None:
            # @NOTE: not logged because somebody may play around with this
            abort(404)

        # only allow specific file types
        if not fname.endswith('.png') and not fname.endswith('.mp3'):
            abort(404)
        
        # try to load asset file from disk
        root  = engine.paths.getGamePath(gmurl, url)
        return static_file(fname, root)

# ---------------------------------------------------------------------

def setup_player_routes(engine):

    @get('/vtt/thumbnail/<gmurl>/<url>/<scene_id:int>')
    def get_scene_thumbnail(gmurl, url, scene_id):
        # load GM from cache
        gm_cache = engine.cache.getFromUrl(gmurl)
        if gm_cache is None:
            # @NOTE: not logged because somebody may play around with this
            abort(404)
            
        # load scene from GM's database
        scene = gm_cache.db.Scene.select(lambda s: s.id == scene_id and s.game.url == url).first()
        if scene is None:
            # @NOTE: not logged because somebody may play around with this
            abort(404)

        engine.paths.getGamePath(gmurl, url)
        if scene.backing != None:
            url = scene.backing.url
        else:
            url = '/static/empty.jpg'

        redirect(url)

    @get('/vtt/thumbnail/<gmurl>/<url>')
    def get_game_thumbnail(gmurl, url):
        # load GM from cache
        gm_cache = engine.cache.getFromUrl(gmurl)
        if gm_cache is None:
            # @NOTE: not logged because somebody may play around with this
            abort(404)
            
        # load game from GM's database
        game = gm_cache.db.Game.select(lambda g: g.url == url).first()
        if game is None:
            # @NOTE: not logged because somebody may play around with this
            abort(404)

        redirect('/vtt/thumbnail/{0}/{1}/{2}'.format(gmurl, url, game.active))

    @get('/vtt/schedule/<timestamp>')
    @view('countdown')
    def vtt_countdown(timestamp):
        return dict(engine=engine, timestamp=timestamp)

    @get('/game/<gmurl>/<url>')
    @get('/game/<gmurl>/<url>/<timestamp>')
    @view('battlemap')
    def get_player_battlemap(gmurl, url, timestamp=None):
        gm = engine.main_db.GM.loadFromSession(request)
        
        # try to load playername from cookie (or from GM name)
        playername = request.get_cookie('playername', default='')
        
        # query whether user is the hosting GM
        session_gm   = engine.main_db.GM.loadFromSession(request)
        you_are_host = session_gm is not None and session_gm.url == gmurl
        
        # query gm of that game
        host = engine.main_db.GM.select(lambda gm: gm.url == gmurl).first()
        if host is None:
            abort(404)
        
        # try to load playercolor from cookieplayercolor = request.get_cookie('playercolor')
        playercolor = request.get_cookie('playercolor')
        if playercolor is None:   
            colors = engine.playercolors
            playercolor = colors[random.randrange(len(colors))]
              
        # load GM from cache
        gm_cache = engine.cache.getFromUrl(gmurl)
        if gm_cache is None:
            abort(404)
        
        # load game from GM's database
        game = gm_cache.db.Game.select(lambda g: g.url == url).first()
        if game is None:
            abort(404)

        websocket_url = engine.getWebsocketUrl()

        supported_dice = engine.getSupportedDice()
        if 100 in supported_dice:
            supported_dice.remove(100)
        supported_dice.reverse()
        
        # show battlemap with login screen ontop
        return dict(engine=engine, websocket_url=websocket_url, game=game, playername=playername, playercolor=playercolor, host=host, gm=gm, dice=supported_dice, timestamp=timestamp)

    @post('/game/<gmurl>/<url>/login')
    def set_player_name(gmurl, url):
        result = {
            'uuid'        : '',
            'is_gm'       : False,
            'playername'  : '',
            'playercolor' : '',
            'error'       : ''
        }
        
        playername  = template('{{value}}', value=format(request.forms.playername))
        playercolor = request.forms.get('playercolor')
          
        # load GM from cache
        gm_cache = engine.cache.getFromUrl(gmurl)
        if gm_cache is None:
            engine.logging.warning('Player tried to login {0} by {1}, but GM was not found.'.format(gmurl, engine.getClientIp(request)))
            result['error'] = 'GAME NOT FOUND'
            return result
        
        # load game from GM's database
        game = gm_cache.db.Game.select(lambda g: g.url == url).first()
        if game is None: 
            engine.logging.warning('Player tried to login {0}/{1} by {2}, but game was not found.'.format(gmurl, url, engine.getClientIp(request)))
            result['error'] = 'GAME NOT FOUND'
            return result
        
        if playername == '':
            engine.logging.warning('Player tried to login {0} by {1}, but did not provide a username.'.format(game.getUrl(), engine.getClientIp(request)))
            result['error'] = 'PLEASE ENTER A NAME'
            return result
        
        # limit length, trim whitespaces
        playername = playername[:30].strip()
        
        # @NOTE: this feature isn't really required anymore
        """
        # make player color less bright
        parts       = [int(playercolor[1:3], 16), int(playercolor[3:5], 16), int(playercolor[5:7], 16)]
        playercolor = '#'
        for c in parts:
            if c > 200:
                c = 200
            if c < 16:
                playercolor += '0'
            playercolor += hex(c)[2:]
        """
        
        # check for player name collision
        game_cache = gm_cache.get(game)
        if game_cache is None:
            engine.logging.warning('Player tried to login {0} by {1}, but game was not in the cache.'.format(game.getUrl(), engine.getClientIp(request)))
            result['error'] = 'GAME NOT FOUND'
            return result
        
        # query whether user is the hosting GM
        session_gm = engine.main_db.GM.loadFromSession(request)
        gm_is_host = session_gm is not None and session_gm.url == gmurl

        # kill all timeout players and login this new player
        try:
            player_cache = game_cache.insert(playername, playercolor, is_gm=gm_is_host)
        except KeyError:
            engine.logging.warning('Player tried to login {0} by {1}, but username "{2}" is already in use.'.format(game.getUrl(), engine.getClientIp(request), playername))
            result['error'] = 'ALREADY IN USE'
            return result
        
        # save playername in client cookie
        expire = int(time.time() + engine.expire)
        response.set_cookie('playername', playername, path=game.getUrl(), expires=expire, secure=engine.hasSsl())
        response.set_cookie('playercolor', playercolor, path=game.getUrl(), expires=expire, secure=engine.hasSsl())
        
        engine.logging.access('Player logged in to {0} by {1}.'.format(game.getUrl(), engine.getClientIp(request)))
        
        result['playername']  = player_cache.name
        result['playercolor'] = player_cache.color
        result['uuid']        = player_cache.uuid
        result['is_gm']       = player_cache.is_gm
        return result

    @get('/vtt/websocket')
    def accept_websocket():
        socket = request.environ.get('wsgi.websocket')
        
        if socket is not None:
            player_cache = engine.cache.listen(socket)
            if player_cache is None:
                return
            # wait until greenlet is closed
            # @NOTE: this keeps the websocket open
            greenlet = player_cache.greenlet
            try:
                greenlet.get()
            except Exception as error:
                error.metadata = player_cache.getMetaData()
                # reraise greenlet's exception to trigger proper error reporting
                raise error

    @post('/game/<gmurl>/<url>/upload')
    def post_image_upload(gmurl, url):
        # load GM from cache
        gm_cache = engine.cache.getFromUrl(gmurl)
        if gm_cache is None:
            abort(404)

        # loda game from cache
        game_cache = gm_cache.getFromUrl(url)
        if game_cache is None:
            abort(404)
        
        # load game from GM's database to upload files
        answer = {'urls': list(), 'music': list()};
        game = gm_cache.db.Game.select(lambda g: g.url == url).first()
        if game is None:
            abort(404)
        
        # load active scene
        scene = gm_cache.db.Scene.select(lambda s: s.id == game.active).first()
        if scene is None:
            abort(404)
        
        background_set = scene.backing is not None
        # query file sizes
        try:
            files = request.files.getall('file[]')
        except OSError:
            # cannot read uploaded files
            abort(404)
        
        for i, handle in enumerate(files):
            content = handle.content_type.split('/')[0]

            # check image size
            if content == 'image':
                max_filesize = engine.file_limit['token']
                if i == 0 and not background_set:
                    max_filesize = engine.file_limit['background']
                # determine file size
                size = engine.getSize(handle)
                # check filesize       
                if size > max_filesize * 1024 * 1024:
                    engine.logging.warning('Player tried to upload an image to a game by {0} but tried to cheat on the filesize'.format(engine.getClientIp(request), url))
                    abort(403) # Forbidden

            # check audio size
            elif content == 'audio':
                max_filesize = engine.file_limit['music'] 
                # determine file size
                size = engine.getSize(handle)
                # check filesize       
                if size > max_filesize * 1024 * 1024:
                    engine.logging.warning('Player tried to upload music to a game by {0} but tried to cheat on the filesize'.format(engine.getClientIp(request), url))
                    abort(403) # Forbidden

            # unsupported filetype
            else:      
                engine.logging.warning('Player tried to "{1}" to a game by {0} which is unsupported'.format(engine.getClientIp(request), handle.content_type))
                abort(403) # Forbidden
        
        # upload files
        for handle in files:
            content = handle.content_type.split('/')[0]

            # check image size
            if content == 'image':
                img_url = game.upload(handle)
                if img_url is not None:
                    answer['urls'].append(img_url)
                    engine.logging.access('Image upload {0} by {1}'.format(url, engine.getClientIp(request)))
                else:
                    engine.logging.access('Image failed to upload by {0}'.format(engine.getClientIp(request)))

            # upload music
            elif content == 'audio':
                slot_id = game_cache.uploadMusic(handle)
                answer['music'].append(slot_id)
        
        # return urls
        # @NOTE: request was non-JSON to allow upload, so urls need to be encoded
        
        return json.dumps(answer)


# ---------------------------------------------------------------------   

def setup_error_routes(engine):

    @error(401)
    @view('error401')
    def error401(error):
        return dict(engine=engine)

    @error(404)
    @view('error404')
    def error404(error):
        return dict(engine=engine)

    @get('/vtt/error/<error_id>')
    @view('error500')
    def caught_error(error_id):
        return dict(engine=engine, error_id=error_id)



if __name__ == '__main__':
    try:
        argv = sys.argv
        
        engine = Engine(argv)   
        setup_resource_routes(engine)
        setup_gm_routes(engine)
        setup_player_routes(engine)
        setup_error_routes(engine)
        
        engine.run()
    except KeyboardInterrupt:
        pass

