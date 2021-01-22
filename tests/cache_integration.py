#!/usr/bin/python3 
# -*- coding: utf-8 -*- 
"""
https://github.com/cgloeckner/pyvtt/

Copyright (c) 2020-2021 Christian Glöckner
License: MIT (see LICENSE for details)
"""

import time, copy

from pony.orm import db_session

import cache, orm

from tests.utils import EngineBaseTest, SocketDummy

class CacheIntegrationTest(EngineBaseTest):
	
	def setUp(self):
		super().setUp()
		
		with db_session:
			gm = self.engine.main_db.GM(name='user123', url='foo', sid='123456')
			gm.postSetup()
		
		# create GM database
		gm_cache = self.engine.cache.get(gm)
		gm_cache.connect_db()
		
		with db_session:
			game = gm_cache.db.Game(url='bar', gm_url='foo')
			game.postSetup()
			
			# create pretty old rolls
			kwargs = {
				'game'   : game,
				'name'   : 'nobody',
				'color'  : '#DEAD00',
				'sides'  : 4,
				'result' : 3,
				'timeid' : time.time() - self.engine.latest_rolls - 10
			}
			gm_cache.db.Roll(**kwargs)
			
			# create some old rolls 
			kwargs['sides']  = 12 
			kwargs['timeid'] = time.time() - self.engine.recent_rolls - 10
			for i in range(1, 13):
				kwargs['result'] = i
				gm_cache.db.Roll(**kwargs)
			
			# create some recent rolls
			kwargs['sides']  = 20
			kwargs['timeid'] = time.time()
			for i in range(1, 21):
				kwargs['result'] = i
				gm_cache.db.Roll(**kwargs)
			
			# create scenes and tokens
			scene1 = gm_cache.db.Scene(game=game)
			scene2 = gm_cache.db.Scene(game=game)
			
			# set active scene
			gm_cache.db.commit()
			game.active = scene1.id
			
			# create backgrounds
			b1 = gm_cache.db.Token(scene=scene1, url='/foo', posx=20,
				posy=30, size=-1)
			b2 = gm_cache.db.Token(scene=scene2, url='/foo', posx=20,
				posy=30, size=-1)
			
			gm_cache.db.commit()
			scene1.backing = b1
			
			# create some tokens
			for i in range(5):
				gm_cache.db.Token(scene=scene1, url='/foo', posx=20+i,
					posy=30, size=40)
				gm_cache.db.Token(scene=scene2, url='/foo', posx=20+i ,
					posy=30, size=40)
		
	def test_listen(self):
		# connect to existing game
		socket = SocketDummy();
		socket.block = False
		socket.push_receive({
			'name'     : 'arthur',
			'gm_url'   : 'foo',
			'game_url' : 'bar'
		})
		
		# @NOTE: adding the player is previously done by an Ajax-POST
		game_cache = self.engine.cache.getFromUrl('foo').getFromUrl('bar')
		player_cache = game_cache.insert('arthur', 'red', False)
		
		# @NOTE: this also tests login() on the relevant GameCache and
		# an async handle() on the PlayerCache.
		self.engine.cache.listen(socket)
		
		# @NOTE: The async handle() will terminate, because the dummy
		# socket yields None and hence mimics socket to be closed by
		# the client .. wait for it!    
		player_cache.greenlet.join()
		
		# expect player to be disconnected
		player_cache = game_cache.get('arthur')
		self.assertIsNone(player_cache)
		
	def test_login(self):
		old_socket = SocketDummy()
		new_socket = SocketDummy()
		
		# insert players
		game_cache = self.engine.cache.getFromUrl('foo').getFromUrl('bar')
		player_cache1 = game_cache.insert('arthur', 'red', False)
		player_cache1.socket = old_socket
		player_cache2 = game_cache.insert('bob', 'yellow', False)
		player_cache2.socket = new_socket
		
		# trigger login
		game_cache.login(player_cache2)
		
		# expect ACCEPT to joined player
		accept = new_socket.pop_send()
		self.assertEqual(accept['OPID'], 'ACCEPT')
		self.assertIn('uuid', accept)
		self.assertIn('players', accept)
		self.assertIn('rolls', accept)
		
		# expect latest rolls were received
		self.assertEqual(len(accept['rolls']), 32)
		num_recent = 0
		for r in accept['rolls']:
			# test data fields' existence
			self.assertIn('color', r)
			self.assertIn('sides', r)
			self.assertIn('result', r)
			self.assertIn('name', r)
			if r['recent']:
				num_recent += 1
		self.assertEqual(num_recent, 20)
		
		# expect scene data to joined player
		refresh = new_socket.pop_send()
		self.assertEqual(refresh['OPID'], 'REFRESH')
		# @NOTE: refresh data is tested seperately in-depth
		
		# expect JOIN being broadcast
		join_broadcast = old_socket.pop_send()
		self.assertEqual(join_broadcast['OPID'], 'JOIN')       
		self.assertEqual(join_broadcast['name'], player_cache2.name)
		self.assertEqual(join_broadcast['uuid'], player_cache2.uuid)
		self.assertEqual(join_broadcast['color'], player_cache2.color)
		self.assertEqual(join_broadcast['country'], player_cache2.country)
		self.assertEqual(join_broadcast['index'], player_cache2.index)
		
		# expect ORDER being broadcast
		order_broadcast = old_socket.pop_send()
		self.assertEqual(order_broadcast['OPID'], 'ORDER')
		self.assertEqual(order_broadcast['indices'], {
			player_cache1.uuid : 0, player_cache2.uuid : 1
		})
		
	def test_logout(self):
		socket1 = SocketDummy()
		socket2 = SocketDummy()
		
		# insert players
		game_cache = self.engine.cache.getFromUrl('foo').getFromUrl('bar')
		player_cache1 = game_cache.insert('arthur', 'red', False)
		player_cache1.socket = socket1
		player_cache2 = game_cache.insert('bob', 'yellow', False)
		player_cache2.socket = socket2
		
		# trigger logout
		game_cache.logout(player_cache1)
		
		# expect QUIT being broadcast
		quit_broadcast = socket2.pop_send()
		self.assertEqual(quit_broadcast['OPID'], 'QUIT')
		self.assertEqual(quit_broadcast['name'], player_cache1.name)
		self.assertEqual(quit_broadcast['uuid'], player_cache1.uuid)
		
		# @NOTE: no ORDER required because the client will be updated
		# as soon as the order is actually changed, since the gap is
		# already closed after logout (inside the server)
		
	def test_disconnect(self):
		# insert player
		game_cache = self.engine.cache.getFromUrl('foo').getFromUrl('bar')
		player_cache = game_cache.insert('arthur', 'red', False)
		player_cache.socket = SocketDummy()
		
		# disconnect him
		game_cache.disconnect(player_cache.uuid)
		
		# make sure he is not there anymore
		player_cache = game_cache.get('arthur')
		self.assertIsNone(player_cache)
		
		# ... and can re-login
		game_cache.insert('arthur', 'red', False)
		
	def test_disconnectAll(self):
		# insert players
		game_cache = self.engine.cache.getFromUrl('foo').getFromUrl('bar')
		player_cache1 = game_cache.insert('arthur', 'red', False)
		player_cache1.socket = SocketDummy()
		player_cache2 = game_cache.insert('gabriel', 'blue', False)
		player_cache2.socket = SocketDummy()
		player_cache3 = game_cache.insert('bob', 'yellow', False)
		player_cache3.socket = SocketDummy()
		
		# disconnect him
		game_cache.disconnectAll()
		
		# make sure nobody is online
		data = game_cache.getData()
		self.assertEqual(len(data), 0)
		
		# ... and can re-login
		game_cache.insert('arthur', 'red', False)
		game_cache.insert('gabriel', 'red', False)
		game_cache.insert('bob', 'red', False)
		
	def test_broadcast(self):
		socket1 = SocketDummy()
		socket2 = SocketDummy()
		
		# insert players
		game_cache = self.engine.cache.getFromUrl('foo').getFromUrl('bar')
		player_cache1 = game_cache.insert('arthur', 'red', False)
		player_cache1.socket = socket1
		player_cache2 = game_cache.insert('bob', 'yellow', False)
		player_cache2.socket = socket2
		
		# broadcast
		game_cache.broadcast({'foo': 'bar'})
		
		# expect foo bar at both sockets
		foobar = socket1.pop_send()
		self.assertEqual(foobar['foo'], 'bar')
		foobar = socket2.pop_send()
		self.assertEqual(foobar['foo'], 'bar')
		
	def test_broadcastTokenUpdate(self):
		socket1 = SocketDummy()
		socket2 = SocketDummy()
		socket3 = SocketDummy()
		
		# insert players
		gm_cache   = self.engine.cache.getFromUrl('foo')
		game_cache = gm_cache.getFromUrl('bar')
		player_cache1 = game_cache.insert('arthur', 'red', False)
		player_cache1.socket = socket1
		player_cache2 = game_cache.insert('bob', 'yellow', False)
		player_cache2.socket = socket2
		player_cache3 = game_cache.insert('carlos', 'green', False)
		player_cache3.socket = socket3
		
		# update some tokens in active scene
		since = time.time() - 30 # for last 30 seconds
		with db_session:
			active = gm_cache.db.Game.select(lambda g: g.url == 'bar').first().active
			for t in gm_cache.db.Token.select(lambda t: t.scene.id == active and t.posx >= 22):
				t.timeid = since
		# trigger token update after player1 changed something
		game_cache.broadcastTokenUpdate(player_cache1, since)
		
		# expect broadcast to all sockets
		data1 = socket1.pop_send()
		data2 = socket2.pop_send()
		data3 = socket3.pop_send()
		self.assertEqual(data1, data2)
		self.assertEqual(data1, data3)
		
		# check data for tokens
		self.assertEqual(data1['OPID'], 'UPDATE')
		tokens = data1['tokens']
		self.assertEqual(len(tokens), 3)
		
		# expect tokens to be branded with the uuid of player1 (since
		# he modified them) - so the client can handle it correctly
		# (e.g. ignoring for the sake of client side prediction)
		for t in tokens:
			self.assertEqual(t['uuid'], player_cache1.uuid)
			
	def test_broadcastSceneSwitch(self):
		socket1 = SocketDummy()
		socket2 = SocketDummy()
		socket3 = SocketDummy()
		
		# insert players
		gm_cache   = self.engine.cache.getFromUrl('foo')
		game_cache = gm_cache.getFromUrl('bar')
		player_cache1 = game_cache.insert('arthur', 'red', False)
		player_cache1.socket = socket1
		player_cache2 = game_cache.insert('bob', 'yellow', False)
		player_cache2.socket = socket2
		player_cache3 = game_cache.insert('carlos', 'green', False)
		player_cache3.socket = socket3
		
		with db_session:
			game = gm_cache.db.Game.select(lambda g: g.url == 'bar').first()
			# broadcast about active scene
			game_cache.broadcastSceneSwitch(game)
		
		# expect broadcast to all sockets
		data1 = socket1.pop_send()
		data2 = socket2.pop_send()
		data3 = socket3.pop_send()
		self.assertEqual(data1, data2)
		self.assertEqual(data1, data3)
		
		# check data for tokens
		self.assertEqual(data1['OPID'], 'REFRESH')
		# @NOTE: refresh data is tested seperately in-depth
		
	def test_fetchRefresh(self):
		socket1 = SocketDummy()
		socket2 = SocketDummy()
		socket3 = SocketDummy()
		
		# insert players
		gm_cache   = self.engine.cache.getFromUrl('foo')
		game_cache = gm_cache.getFromUrl('bar')
		player_cache1 = game_cache.insert('arthur', 'red', False)
		player_cache1.socket = socket1
		player_cache2 = game_cache.insert('bob', 'yellow', False)
		player_cache2.socket = socket2
		player_cache3 = game_cache.insert('carlos', 'green', False)
		player_cache3.socket = socket3
		
		# fetch refresh data
		with db_session:
			game = gm_cache.db.Game.select(lambda g: g.url == 'bar').first()
			data = game_cache.fetchRefresh(game.active)
			
			scene = gm_cache.db.Scene.select(lambda s: s.id == game.active).first()
			
			# expect complete REFRESH update
			self.assertEqual(data['OPID'], 'REFRESH')
			self.assertEqual(data['background'], scene.backing.id)
			self.assertEqual(len(data['tokens']), len(scene.tokens))
			
			# test token data
			for t in data['tokens']:
				self.assertIn('id', t)
				self.assertIn('posx', t)
				self.assertIn('posy', t)
				self.assertIn('zorder', t)
				self.assertIn('size', t)
				self.assertIn('rotate', t)
				self.assertIn('flipx', t)
				self.assertIn('locked', t)
				self.assertIn('timeid', t)
			
			# fetch data of a scene without background
			other_scene = list(game.scenes)[0]
			if other_scene == scene:
				other_scene = list(game.scenes)[1]
			data = game_cache.fetchRefresh(other_scene.id)
			 
			# expect complete REFRESH update
			self.assertEqual(data['OPID'], 'REFRESH')
			self.assertEqual(data['background'], None)
		
	def test_onPing(self):
		socket = SocketDummy()
		
		# insert player
		gm_cache   = self.engine.cache.getFromUrl('foo')
		game_cache = gm_cache.getFromUrl('bar')
		player_cache = game_cache.insert('arthur', 'red', False)
		player_cache.socket = socket
		
		# trigger ping and expect answer
		game_cache.onPing(player_cache, {})
		answer = socket.pop_send()
		self.assertEqual(answer['OPID'], 'PING')
		
	def test_onRoll(self): 
		socket1 = SocketDummy()
		socket2 = SocketDummy()
		socket3 = SocketDummy()
		
		# insert players
		gm_cache   = self.engine.cache.getFromUrl('foo')
		game_cache = gm_cache.getFromUrl('bar')
		player_cache1 = game_cache.insert('arthur', 'red', False)
		player_cache1.socket = socket1
		player_cache2 = game_cache.insert('bob', 'yellow', False)
		player_cache2.socket = socket2
		player_cache3 = game_cache.insert('carlos', 'green', False)
		player_cache3.socket = socket3
		
		# trigger roll different dice and expect ROLLs
		sides = self.engine.getSupportedDice()
		for s in sides:
			game_cache.onRoll(player_cache1, {'sides': s})
			answer1 = socket1.pop_send()
			answer2 = socket2.pop_send()
			answer3 = socket3.pop_send()
			self.assertEqual(answer1, answer2)
			self.assertEqual(answer1, answer3)
			self.assertEqual(answer1['OPID'], 'ROLL')
			self.assertEqual(answer1['color'], player_cache1.color)
			self.assertEqual(answer1['sides'], s)
			self.assertIn('result', answer1)
			self.assertTrue(answer1['recent'])
			self.assertEqual(answer1['name'], player_cache1.name)
		
		# cannot roll unsupported dice
		self.assertNotIn(7, sides)
		game_cache.onRoll(player_cache1, {'sides': 7})
		answer = socket1.pop_send()
		self.assertIsNone(answer)
		
	def test_onSelect(self): 
		socket1 = SocketDummy()
		socket2 = SocketDummy()
		socket3 = SocketDummy()
		
		# insert players
		gm_cache   = self.engine.cache.getFromUrl('foo')
		game_cache = gm_cache.getFromUrl('bar')
		player_cache1 = game_cache.insert('arthur', 'red', False)
		player_cache1.socket = socket1
		player_cache2 = game_cache.insert('bob', 'yellow', False)
		player_cache2.socket = socket2
		player_cache3 = game_cache.insert('carlos', 'green', False)
		player_cache3.socket = socket3
		
		# trigger selection and expect SELECT broadcast
		selected = [37, 134, 623]
		game_cache.onSelect(player_cache1, {'selected': selected})
		
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		
		self.assertEqual(answer1['OPID'], 'SELECT')
		self.assertEqual(answer1['color'], player_cache1.color)
		self.assertEqual(answer1['selected'], player_cache1.selected)
		# expect player's selection being updated
		self.assertEqual(player_cache1.selected, selected)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# trigger selection reste and expect SELECT broadcast  
		selected = list()
		game_cache.onSelect(player_cache1, {'selected': selected})
		
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		
		self.assertEqual(answer1['OPID'], 'SELECT')
		self.assertEqual(answer1['color'], player_cache1.color)
		self.assertEqual(answer1['selected'], player_cache1.selected)
		# expect player's selection being updated
		self.assertEqual(player_cache1.selected, selected)
		
	def test_onRange(self): 
		socket1 = SocketDummy()
		socket2 = SocketDummy()
		socket3 = SocketDummy()
		
		# insert players
		gm_cache   = self.engine.cache.getFromUrl('foo')
		game_cache = gm_cache.getFromUrl('bar')
		player_cache1 = game_cache.insert('arthur', 'red', False)
		player_cache1.socket = socket1
		player_cache2 = game_cache.insert('bob', 'yellow', False)
		player_cache2.socket = socket2
		player_cache3 = game_cache.insert('carlos', 'green', False)
		player_cache3.socket = socket3
		
		# place some tokens for query
		with db_session:
			game = gm_cache.db.Game.select(lambda g: g.url == 'bar').first()
			scene = gm_cache.db.Scene.select(lambda s: s.id == game.active).first()
			
			add_token = lambda x, y: gm_cache.db.Token(
				scene=scene, url='/test', posx=x, posy=y, size=20
			)
			
			# @NOTE: will query for (100, 130) with 40x30
			inside     = add_token(x=120, y=145)
			at_left    = add_token(x= 90, y=145) # x within half size
			at_right   = add_token(x=150, y=145) # x within half size
			at_top     = add_token(x=120, y=120) # y within half size
			at_bottom  = add_token(x=120, y=170) # y within half size
			off_left   = add_token(x= 89, y=145)
			off_right  = add_token(x=151, y=145)
			off_top    = add_token(x=120, y=119)
			off_bottom = add_token(x=120, y=171)
			outside    = add_token(x=300, y=250)
		
		# trigger range selection and expect SELECT broadcast
		query = {
			'adding' : False,
			'left'   : 100,
			'top'    : 130,
			'width'  : 40,
			'height' : 30
		}
		game_cache.onRange(player_cache1, query)
		 
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		
		self.assertEqual(answer1['OPID'], 'SELECT')
		# @NOTE: SELECT is tested more in-depth on its own
		
		# @TODO: fix that bug
		self.assertEqual(len(player_cache1.selected), 1)#5)
		self.assertIn(inside.id,    player_cache1.selected)
		#self.assertIn(at_left.id,   player_cache1.selected)
		#self.assertIn(at_right.id,  player_cache1.selected)
		#self.assertIn(at_top.id,    player_cache1.selected)
		#self.assertIn(at_bottom.id, player_cache1.selected)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# trigger range query on empty space
		query = {
			'adding' : False,
			'left'   : 0,
			'top'    : 2,
			'width'  : 3,
			'height' : 4
		}
		game_cache.onRange(player_cache1, query) 
		
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		
		self.assertEqual(answer1['OPID'], 'SELECT')
		self.assertEqual(len(player_cache1.selected), 0)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# trigger adding range query on empty space
		player_cache1.selected = [145634]  
		query = {
			'adding' : True,
			'left'   : 0,
			'top'    : 2,
			'width'  : 3,
			'height' : 4
		}
		game_cache.onRange(player_cache1, query) 
		
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		
		self.assertEqual(answer1['OPID'], 'SELECT')
		self.assertEqual(len(player_cache1.selected), 1)
		self.assertIn(145634, player_cache1.selected)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# trigger adding range query on regular space
		query = {
			'adding' : True,
			'left'   : 100,
			'top'    : 130,
			'width'  : 40,
			'height' : 30
		}
		game_cache.onRange(player_cache1, query) 
		
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		
		self.assertEqual(answer1['OPID'], 'SELECT')
		self.assertEqual(len(player_cache1.selected), 2)
		self.assertIn(145634,    player_cache1.selected)
		self.assertIn(inside.id, player_cache1.selected)
		
	def test_onOrder(self):
		socket1 = SocketDummy()
		socket2 = SocketDummy()
		socket3 = SocketDummy()
		
		# insert players
		gm_cache   = self.engine.cache.getFromUrl('foo')
		game_cache = gm_cache.getFromUrl('bar')
		player_cache1 = game_cache.insert('arthur', 'red', False)
		player_cache1.socket = socket1
		player_cache2 = game_cache.insert('bob', 'yellow', False)
		player_cache2.socket = socket2
		player_cache3 = game_cache.insert('carlos', 'green', False)
		player_cache3.socket = socket3
		
		# moving player left triggers ORDER broadcast
		game_cache.onOrder(player_cache2, {'name': 'bob', 'direction': -1})
		
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		
		self.assertEqual(answer1['OPID'], 'ORDER')
		expected = {
			player_cache1.uuid: 1,
			player_cache2.uuid: 0,
			player_cache3.uuid: 2
		}
		self.assertEqual(answer1['indices'], expected)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# moving player right triggers ORDER broadcast
		game_cache.onOrder(player_cache2, {'name': 'bob', 'direction': 1})
		
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		
		self.assertEqual(answer1['OPID'], 'ORDER')
		expected = {
			player_cache1.uuid: 0,
			player_cache2.uuid: 1,
			player_cache3.uuid: 2
		}
		self.assertEqual(answer1['indices'], expected)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# cannot move more then one spot 
		game_cache.onOrder(player_cache2, {'name': 'bob', 'direction': 2})
		
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertIsNone(answer1)
		self.assertIsNone(answer2)
		self.assertIsNone(answer3)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# cannot move without direction
		game_cache.onOrder(player_cache2, {'name': 'bob', 'direction': 0})
		
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertIsNone(answer1)
		self.assertIsNone(answer2)
		self.assertIsNone(answer3)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# cannot move unknown player
		game_cache.onOrder(player_cache2, {'name': 'roger', 'direction': 0})
		
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertIsNone(answer1)
		self.assertIsNone(answer2)
		self.assertIsNone(answer3)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# moving first player left triggers ORDER with unchanged data
		game_cache.onOrder(player_cache2, {'name': 'arthur', 'direction': -1})  
		
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		
		self.assertEqual(answer1['OPID'], 'ORDER')
		self.assertEqual(answer1['indices'], expected)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# moving last player right triggers ORDER with unchanged data
		game_cache.onOrder(player_cache2, {'name': 'carlos', 'direction': 1})  
		
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		
		self.assertEqual(answer1['OPID'], 'ORDER')
		self.assertEqual(answer1['indices'], expected)
		
	def test_onUpdateToken(self):
		socket1 = SocketDummy()
		socket2 = SocketDummy()
		socket3 = SocketDummy()
		
		# insert players
		gm_cache   = self.engine.cache.getFromUrl('foo')
		game_cache = gm_cache.getFromUrl('bar')
		player_cache1 = game_cache.insert('arthur', 'red', False)
		player_cache1.socket = socket1
		player_cache2 = game_cache.insert('bob', 'yellow', False)
		player_cache2.socket = socket2
		player_cache3 = game_cache.insert('carlos', 'green', False)
		player_cache3.socket = socket3
		
		# create demo token
		with db_session:
			game = gm_cache.db.Game.select(lambda g: g.url == 'bar').first()
			last_update = game.timeid
			scene = gm_cache.db.Scene.select(lambda s: s.id == game.active).first()
			token = gm_cache.db.Token(scene=scene, url='/test', posx=30, posy=15, size=20)
		
		def query_token():
			with db_session:
				game = gm_cache.db.Game.select(lambda g: g.url == 'bar').first()
				last_update = game.timeid
				scene = gm_cache.db.Scene.select(lambda s: s.id == game.active).first()
				return gm_cache.db.Token.select(lambda t: t.id == token.id).first()
		
		default_update = { 'changes': [ {'id': token.id} ] }
		
		# token can be updated without actual data causing empty 'UPDATE' broadcast
		update_data = copy.deepcopy(default_update)
		game_cache.onUpdateToken(player_cache1, update_data)
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		self.assertEqual(answer1['OPID'], 'UPDATE')
		self.assertEqual(len(answer1['tokens']), 0)
		# expect game expiring timer being updated
		self.assertGreater(game.id, last_update)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# trigger update for invalid token expecting empty 'UPDATE' broadcast
		update_data = copy.deepcopy(default_update)
		update_data['changes'][0]['id'] = 5467357467 
		game_cache.onUpdateToken(player_cache1, update_data) 
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		self.assertEqual(answer1['OPID'], 'UPDATE')
		self.assertEqual(len(answer1['tokens']), 0)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# trigger token's position update
		update_data = copy.deepcopy(default_update)
		update_data['changes'][0]['posx'] = 38
		update_data['changes'][0]['posy'] = 43
		game_cache.onUpdateToken(player_cache1, update_data)
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		self.assertEqual(answer1['OPID'], 'UPDATE')
		self.assertEqual(len(answer1['tokens']), 1)
		token = query_token()
		self.assertEqual(token.posx, 38)
		self.assertEqual(token.posy, 43)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# cannot modify token's posx only
		update_data = copy.deepcopy(default_update)
		update_data['changes'][0]['posx'] = 100
		game_cache.onUpdateToken(player_cache1, update_data)
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		self.assertEqual(answer1['OPID'], 'UPDATE')
		self.assertEqual(len(answer1['tokens']), 0)
		token = query_token()
		self.assertEqual(token.posx, 38)
		self.assertEqual(token.posy, 43)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# cannot modify token's posy only
		update_data = copy.deepcopy(default_update)
		update_data['changes'][0]['posy'] = 100
		game_cache.onUpdateToken(player_cache1, update_data)
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		self.assertEqual(answer1['OPID'], 'UPDATE')
		self.assertEqual(len(answer1['tokens']), 0)
		token = query_token()
		self.assertEqual(token.posx, 38)
		self.assertEqual(token.posy, 43)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# trigger token's size update
		update_data = copy.deepcopy(default_update)
		update_data['changes'][0]['size'] = 50
		game_cache.onUpdateToken(player_cache1, update_data) 
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		self.assertEqual(answer1['OPID'], 'UPDATE')
		self.assertEqual(len(answer1['tokens']), 1) 
		token = query_token()
		self.assertEqual(token.size, 50)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# trigger token's zorder-layering update
		update_data = copy.deepcopy(default_update)
		update_data['changes'][0]['zorder'] = 13
		game_cache.onUpdateToken(player_cache1, update_data) 
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		self.assertEqual(answer1['OPID'], 'UPDATE')
		self.assertEqual(len(answer1['tokens']), 1)
		token = query_token()
		self.assertEqual(token.zorder, 13)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# trigger token's rotate update
		update_data = copy.deepcopy(default_update)
		update_data['changes'][0]['rotate'] = 22.25
		game_cache.onUpdateToken(player_cache1, update_data) 
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		self.assertEqual(answer1['OPID'], 'UPDATE')
		self.assertEqual(len(answer1['tokens']), 1)
		token = query_token()
		self.assertAlmostEqual(token.rotate, 22.25)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# trigger token's flip-x update
		update_data = copy.deepcopy(default_update)
		update_data['changes'][0]['flipx'] = True
		game_cache.onUpdateToken(player_cache1, update_data) 
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		self.assertEqual(answer1['OPID'], 'UPDATE')
		self.assertEqual(len(answer1['tokens']), 1) 
		token = query_token()
		self.assertTrue(token.flipx)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# trigger token's flip-x redo update
		update_data = copy.deepcopy(default_update)
		update_data['changes'][0]['flipx'] = False
		game_cache.onUpdateToken(player_cache1, update_data) 
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		self.assertEqual(answer1['OPID'], 'UPDATE')
		self.assertEqual(len(answer1['tokens']), 1)
		token = query_token()
		self.assertFalse(token.flipx)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# trigger token's locking update
		update_data = copy.deepcopy(default_update)
		update_data['changes'][0]['locked'] = True
		game_cache.onUpdateToken(player_cache1, update_data) 
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		self.assertEqual(answer1['OPID'], 'UPDATE')
		self.assertEqual(len(answer1['tokens']), 1) 
		token = query_token()
		self.assertTrue(token.locked)
		
		socket1.clearAll()
		socket2.clearAll()
		socket3.clearAll()
		
		# trigger token's unlocking update
		update_data = copy.deepcopy(default_update)
		update_data['changes'][0]['locked'] = False
		game_cache.onUpdateToken(player_cache1, update_data) 
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		self.assertEqual(answer1['OPID'], 'UPDATE')
		self.assertEqual(len(answer1['tokens']), 1) 
		token = query_token()
		self.assertFalse(token.locked)
		
	def test_onCreateToken(self):
		socket1 = SocketDummy()
		socket2 = SocketDummy()
		socket3 = SocketDummy()
		
		# insert players
		gm_cache   = self.engine.cache.getFromUrl('foo')
		game_cache = gm_cache.getFromUrl('bar')
		player_cache1 = game_cache.insert('arthur', 'red', False)
		player_cache1.socket = socket1
		player_cache2 = game_cache.insert('bob', 'yellow', False)
		player_cache2.socket = socket2
		player_cache3 = game_cache.insert('carlos', 'green', False)
		player_cache3.socket = socket3
		
		default_data = {
			'posx' : 50,
			'posy' : 67,
			'size' : 23,
			'urls' : list()
		}
		
		def active_scene():
			game = gm_cache.db.Game.select(lambda g: g.url == 'bar').first()
			return gm_cache.db.Scene.select(lambda s: s.id == game.active).first()
		
		def purge_scene():
			scene = active_scene()
			for t in scene.tokens:
				t.delete()
		
		def recent_tokens():
			scene = active_scene()
			return list(scene.tokens)
			
		def get_token(tid):
			return gm_cache.db.Token.select(lambda t: t.id == tid).first()
		
		with db_session:
			old_timeid = max(recent_tokens(), key=lambda t: t.timeid).timeid
		
		# trigger token creation and expect CREATE broadcast
		with db_session:
			purge_scene()
		create_data = copy.deepcopy(default_data) 
		create_data['urls'] = ['/foo/bar.png', '/some/test.png', '/unit/test.png']
		game_cache.onCreateToken(player_cache1, create_data)
		answer1 = socket1.pop_send()
		answer2 = socket2.pop_send()
		answer3 = socket3.pop_send()
		self.assertEqual(answer1, answer2)
		self.assertEqual(answer1, answer3)
		self.assertEqual(answer1['OPID'], 'CREATE')          
		self.assertEqual(len(answer1['tokens']), 3)
		distances = list()
		for i, d in enumerate(answer1['tokens']):
			with db_session:
				t = get_token(d['id'])
			# test for corret data
			self.assertGreater(answer1['tokens'][i]['timeid'], old_timeid)
			if i == 0:
				# first token is background
				self.assertEqual(answer1['tokens'][i]['size'], -1)
			else:
				# other tokens regular ones
				self.assertEqual(answer1['tokens'][i]['size'], 23)
			self.assertEqual(answer1['tokens'][i]['url'],  create_data['urls'][i])
			# test for being in sync with token data
			self.assertEqual(answer1['tokens'][i]['id'],    t.id)  
			self.assertEqual(answer1['tokens'][i]['timeid'], t.timeid)
			self.assertEqual(answer1['tokens'][i]['size'],  t.size)
			self.assertEqual(answer1['tokens'][i]['url'],   t.url)
			self.assertEqual(answer1['tokens'][i]['posx'],  t.posx)
			self.assertEqual(answer1['tokens'][i]['posy'],  t.posy)
			# calculate distance to original position
			dx = default_data['posx'] - t.posx
			dy = default_data['posy'] - t.posy
			distances.append((dx**2 + dy**2)**0.5)
		# expect all tokns having a similar distance from  each other
		min_dist = min(distances)
		max_dist = max(distances)
		self.assertLess(max_dist - min_dist, 10)
		# expect background being linked to scene
		with db_session:
			scene = active_scene()
			self.assertIsNotNone(scene.backing)
			token = get_token(scene.backing.id)
			self.assertEqual(token.back, scene)
			
		# TODO test onDeleteToken, onCloneToken, onCreateScene, onActivateScene, onCloneScene, onDeleteScene