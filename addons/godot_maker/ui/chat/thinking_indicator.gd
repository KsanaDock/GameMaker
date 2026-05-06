@tool
extends HBoxContainer

var _label: Label
var _icon: Label
var _timer: Timer
var _spinner_frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
var _spinner_idx = 0

func _ready() -> void:
	alignment = BoxContainer.ALIGNMENT_BEGIN
	add_theme_constant_override("separation", 0)
	
	# Icon: Loading Spinner
	_icon = Label.new()
	_icon.text = _spinner_frames[0]
	_icon.add_theme_color_override("font_color", Color("#8e8e8e"))
	_icon.add_theme_font_size_override("font_size", 14)
	add_child(_icon)
	
	# Status Label
	_label = Label.new()
	_label.text = "Agent is thinking..."
	_label.add_theme_color_override("font_color", Color("#8e8e8e"))
	_label.add_theme_font_size_override("font_size", 13)
	add_child(_label)
	
	_timer = Timer.new()
	_timer.wait_time = 0.1 # Faster for spinner
	_timer.autostart = true
	_timer.timeout.connect(_on_timer_timeout)
	add_child(_timer)

func set_status(text: String) -> void:
	if _label:
		_label.text = text

func _on_timer_timeout() -> void:
	_spinner_idx = (_spinner_idx + 1) % _spinner_frames.size()
	_icon.text = _spinner_frames[_spinner_idx]
