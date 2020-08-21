%title = '{0}: {1}'.format(playername, game.title)

%include("header", title=title)

<div class="scene">
	<div id="rollbox">
	</div>

%width = 1200
	<div class="battlemap">
		<canvas id="battlemap" width="{{width}}" height=720"></canvas>
		
		<div class="mapfooter">
			<div class="dicebox">
%for sides in [4, 6, 8, 10, 12, 20]:
				<img src="/static/d{{sides}}.png" id="d{{sides}}" title="Roll 1D{{sides}}" />
%end
			</div>
			
			<div id="players"></div>

			<div id="tokenbar">
				<img src="/static/locked.png" id="tokenLock" onClick="tokenLock();" /><br />
				<img src="/static/top.png" id="tokenTop" class="out" onClick="tokenTop();" /><br />
				<img src="/static/bottom.png" id="tokenBottom" class="out" onClick="tokenBottom();" /><br />
				<img src="/static/stretch.png" id="tokenStretch" onClick="tokenStretch();" /><br />
			</div>
			
			<form id="uploadform" method="post" enctype="multipart/form-data">
				<input id="uploadqueue" name="file[]" type="file" multiple />
			</form>
			
			<div id="error">Connecting...</div>

		</div>
	</div>
</div>

<script>
// disable scrolling
//$('body').css('overflow', 'hidden');

%for sides in [4, 6, 8, 10, 12, 20]:
$('#d{{sides}}').on('singleclick', function(event) {
	rollDice({{sides}});
});
%end
$('#d10').on('dblclick', function(event) {
	rollDice(100);
});

var battlemap = $('#battlemap')[0];

$(window).on('unload', function() {
	disconnect();
});

// disable window context menu for token right click
document.addEventListener('contextmenu', event => {
  event.preventDefault();
});

// drop zone implementation (using canvas) --> also as players :) 
battlemap.addEventListener('dragover', uploadDrag);
battlemap.addEventListener('drop', uploadDrop);

// desktop controls
battlemap.addEventListener('mousedown', tokenGrab);
battlemap.addEventListener('mousemove', tokenMove);
battlemap.addEventListener('mouseup', tokenRelease);
battlemap.addEventListener('wheel', tokenWheel);
document.addEventListener('keydown', tokenShortcut);

// mobile control fix
battlemap.addEventListener('touchstart', tokenGrab);
battlemap.addEventListener('touchmove', tokenMove);
battlemap.addEventListener('touchend', tokenRelease);


start('{{game.title}}');
</script>

%include("footer")

