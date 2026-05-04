@tool
extends HBoxContainer

var _label: Label
var _icon: Label
var _timer: Timer
var _dots = 0

func _ready() -> void:
	alignment = BoxContainer.ALIGNMENT_BEGIN
	add_theme_constant_override("separation", 10)
	
	# Icon: Animated pulsing dot or simple icon
	_icon = Label.new()
	_icon.text = "✦"
	_icon.add_theme_color_override("font_color", Color("#10b981")) # Emerald
	_icon.add_theme_font_size_override("font_size", 16)
	add_child(_icon)
	
	# Status Label
	_label = Label.new()
	_label.text = "Agent is thinking..."
	_label.add_theme_color_override("font_color", Color("#8e8e8e"))
	_label.add_theme_font_size_override("font_size", 13)
	add_child(_label)
	
	# Setup Animation: Pulsing Icon
	var tween = create_tween().set_loops()
	tween.tween_property(_icon, "modulate:a", 0.3, 0.6).set_trans(Tween.TRANS_SINE)
	tween.tween_property(_icon, "modulate:a", 1.0, 0.6).set_trans(Tween.TRANS_SINE)
	
	# Subtitle subtle shimmer
	var label_tween = create_tween().set_loops()
	label_tween.tween_property(_label, "modulate", Color(1.0, 1.0, 1.0, 0.7), 1.0)
	label_tween.tween_property(_label, "modulate", Color(1.0, 1.0, 1.0, 1.0), 1.0)
	
	_timer = Timer.new()
	_timer.wait_time = 0.5
	_timer.autostart = true
	_timer.timeout.connect(_on_timer_timeout)
	add_child(_timer)

func set_status(text: String) -> void:
	if _label:
		_label.text = text
		_dots = 0

func _on_timer_timeout() -> void:
	_dots = (_dots + 1) % 4
	var base_text = _label.text.split("...")[0]
	# Only append dots if it looks like a "thinking" status
	if "..." in _label.text or _label.text.length() < 30:
		_label.text = base_text + ".".repeat(_dots)
