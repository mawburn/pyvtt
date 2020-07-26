%if gm:
	%title = '[GM] {0} @ {1}'.format(game.title, game.active)
%else:
	%title = '[{0}] {1}'.format(player.name, game.title)
%end

%include("header", title=title)

<div id="players"></div>

<div class="scene">
	<div class="dicebox">
%for sides in [4, 6, 8, 10, 12, 20]:
		<img class="d{{sides}}" src="/static/d{{sides}}.png" onClick="rollDice({{sides}});" />
%end
		<div id="rollbox">
		</div>
		
%if gm:
		<div class="gm_info">
			<input type="checkbox" name="locked" id="locked" onChange="tokenLock()" /><label for="locked">Locked</label>
			<input type="button" onClick="tokenStretch()" value="stretch" />
			<input type="button" onClick="tokenClone()" value="clone" />
			<input type="button" onClick="tokenDelete()" value="delete" />
		</div>
%else:
		<input type="checkbox" style="display: none" name="locked" id="locked" onChange="tokenLock()" />
%end
	</div>
	
%width = 1000
%if gm:
	%width += 200
%end
	<div class="battlemap">
		<canvas id="battlemap" width="{{width}}" height="720"></canvas>
	</div>
</div>

%if gm:
<form class="upload" action="/gm/{{game.title}}/upload" method="post" enctype="multipart/form-data">
	<input name="file[]" type="file" multiple />
	<input type="submit" value="upload" />
</form>
%end

<script>
var battlemap = $('#battlemap')[0];

/** Mobile controls not working yet
battlemap.addEventListener('touchstart', tokenGrab);
battlemap.addEventListener('touchmove', tokenMove);
battlemap.addEventListener('touchend', tokenRelease);
*/

// desktop controls
battlemap.addEventListener('mousedown', tokenGrab);
battlemap.addEventListener('mousemove', tokenMove);
battlemap.addEventListener('mouseup', tokenRelease);
battlemap.addEventListener('wheel', tokenWheel);

start('{{game.title}}');
</script>

%include("footer")

