@tool
extends VBoxContainer
## GodotMaker AI 对话面板（Chat Dock）

const MessageBubble = preload("res://addons/godot_maker/ui/chat/message_bubble.gd")

var _auth: KAuthClient

var _bridge: Node # The GodotMaker Bridge instance

@onready var _msg_list: VBoxContainer = %MsgList
@onready var _scroll: ScrollContainer = %Scroll
@onready var _input_field: TextEdit = %InputField
@onready var _send_btn: Button = %SendBtn
@onready var _clear_btn: Button = %ClearBtn
@onready var _ref_list: HBoxContainer = %RefList
@onready var _input_bg: PanelContainer = $InputBG
@onready var _provider_btn: OptionButton = %ProviderBtn
@onready var _model_select_btn: OptionButton = %ModelSelectBtn
var _current_provider: String = ""
var _selected_model: String = ""

signal api_key_saved

@onready var _api_key_dialog: AcceptDialog = %APIKeyDialog
@onready var _api_key_input: LineEdit = %APIKeyInput
@onready var _api_key_eye_btn: Button = %APIKeyEyeBtn
@onready var _settings_btn: Button = %SettingsBtn
@onready var _settings_dialog: AcceptDialog = %SettingsDialog
@onready var _sf_input: LineEdit = %SiliconFlowInput
@onready var _or_input: LineEdit = %OpenRouterInput
@onready var _xm_input: LineEdit = %XiaomiMiMoInput
@onready var _sf_eye_btn: Button = %SFEyeBtn
@onready var _or_eye_btn: Button = %OREyeBtn
@onready var _xm_eye_btn: Button = %XMEyeBtn
@onready var _zai_input: LineEdit = %ZAIMiMoInput
@onready var _zai_eye_btn: Button = %ZAIEyeBtn
var _messages: Array[Dictionary] = []  # {role, content}
var _current_bubble: VBoxContainer = null
var _thinking_indicator: Control = null
var _is_streaming := false
var _active_subagents: Dictionary = {} # agentId -> MessageBubble
var _context_refs: Array[Dictionary] = [] # {type, data, label}
var _grab_btn: Button
var _rollback_dialog: AcceptDialog
var _rollback_list: ItemList
var _rollback_detail: RichTextLabel
var _rollback_restore_btn: Button
var _rollback_checkpoints: Array = []
var _selected_checkpoint_id: String = ""
var _pending_user_bubble: VBoxContainer = null
var _input_normal: StyleBoxFlat
var _input_focused: StyleBoxFlat
var _attach_img_btn: Button
var _img_dialog: FileDialog
var _pending_images: Array[Dictionary] = [] # {base64: String, texture: ImageTexture}
var _img_preview: HBoxContainer
const MAX_IMAGE_SIZE_MB := 4.0
const MAX_IMAGE_COUNT := 3


func _process(_delta: float) -> void:
	if not Engine.is_editor_hint(): return
	
	if _bridge and not is_instance_valid(_bridge):
		_bridge = null
		
	if not _bridge and EditorInterface.get_base_control().has_meta("ksanadock_bridge"):
		set_bridge(EditorInterface.get_base_control().get_meta("ksanadock_bridge"))


func _draw() -> void:
	# 用主题色填充整个聊天区域，覆盖 Godot 编辑器 Dock 默认的 #292929 底色
	draw_rect(Rect2(Vector2.ZERO, size), KPalette.BG_MAIN)


func _notification(what: int) -> void:
	if what == NOTIFICATION_RESIZED:
		queue_redraw()

func _ready() -> void:
	name = "Chat"
	if _scroll:
		_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	
	KTranslationManager.initialize()
	KTranslationManager.add_listener(_on_locale_changed)
	
	_apply_theme()
	_update_ui_localization()
	_connect_signals()


func _load_persisted_state() -> void:
	var es := EditorInterface.get_editor_settings()
	var saved_provider = es.get_setting("ksanadock/ai_provider") if es.has_setting("ksanadock/ai_provider") else ""
	if saved_provider == "siliconflow":
		if _provider_btn: _provider_btn.select(1)
		_current_provider = "siliconflow"
	elif saved_provider == "openrouter":
		if _provider_btn: _provider_btn.select(2)
		_current_provider = "openrouter"
	elif saved_provider == "xiaomi":
		if _provider_btn: _provider_btn.select(3)
		_current_provider = "xiaomi"
	elif saved_provider == "zai":
		if _provider_btn: _provider_btn.select(4)
		_current_provider = "zai"
		
	if _current_provider != "":
		var key = _auth.get_api_key(_current_provider) if _auth else ""
		if key != "":
			_validate_and_fetch_models(key, _current_provider)

func _on_locale_changed(_lang: String) -> void:
	_update_ui_localization()





func initialize(auth: KAuthClient) -> void:
	if _auth == auth: return
	_auth = auth
	
	_load_persisted_state()
	
	# 欢迎消息
	if _messages.is_empty():
		_add_bubble(MessageBubble.Role.AI, _tr("welcome"))



func _apply_theme() -> void:
	# 大部分样式已移至 chat_theme.tres
	pass


func _tr(key: String) -> String:
	return KTranslationManager.get_text("chat", key)


func _update_ui_localization() -> void:
	if _grab_btn:
		_grab_btn.text = _tr("grab_output")
	if _api_key_dialog:
		_api_key_dialog.title = _tr("enter_api_key_title")
	if _api_key_input:
		_api_key_input.placeholder_text = _tr("enter_api_key_placeholder")
	
	if _settings_btn:
		_settings_btn.text = _tr("settings_title")
	if _settings_dialog:
		_settings_dialog.title = _tr("settings_title")
		_settings_dialog.get_ok_button().text = _tr("settings_save")
		var vbox = _settings_dialog.get_child(0, true) # VBox
		if vbox:
			var label = vbox.get_node_or_null("Label")
			if label: label.text = _tr("api_key_management")
			var grid = vbox.get_node_or_null("Grid")
			if grid:
				var sf_label = grid.get_node_or_null("SFLabel")
				if sf_label: sf_label.text = _tr("siliconflow_key")
				var or_label = grid.get_node_or_null("ORLabel")
				if or_label: or_label.text = _tr("openrouter_key")
				var xm_label = grid.get_node_or_null("XMLabel")
				if xm_label: xm_label.text = _tr("xiaomi_key")

	# 如果只有一条欢迎消息，则尝试刷新欢迎消息的语言
	if _messages.is_empty() and _msg_list.get_child_count() == 1:
		var first = _msg_list.get_child(0)
		if first.has_method("set_message"):
			first.set_message(_tr("welcome"))


func _connect_signals() -> void:
	_send_btn.pressed.connect(_send_message)
	_clear_btn.pressed.connect(_clear_chat)
	_settings_btn.pressed.connect(_open_settings)
	_settings_dialog.confirmed.connect(_on_settings_confirmed)
	
	if _api_key_eye_btn:
		_api_key_eye_btn.pressed.connect(func(): _api_key_input.secret = not _api_key_input.secret)
	if _sf_eye_btn:
		_sf_eye_btn.pressed.connect(func(): _sf_input.secret = not _sf_input.secret)
	if _or_eye_btn:
		_or_eye_btn.pressed.connect(func(): _or_input.secret = not _or_input.secret)
	if _xm_eye_btn:
		_xm_eye_btn.pressed.connect(func(): _xm_input.secret = not _xm_input.secret)
	
	_grab_btn = Button.new()
	_grab_btn.text = _tr("grab_output")
	_grab_btn.add_theme_font_size_override("font_size", 11)
	_grab_btn.add_theme_font_size_override("font_size", 11)
	_grab_btn.pressed.connect(_grab_output_selection)
	if has_node("%CtxBar"):
		get_node("%CtxBar").add_child(_grab_btn)

	_create_rollback_dialog()

	# ── 图片上传按钮 ──
	_attach_img_btn = Button.new()
	_attach_img_btn.text = " 📎"
	_attach_img_btn.tooltip_text = _tr("attach_image")
	_attach_img_btn.add_theme_font_size_override("font_size", 14)
	_attach_img_btn.add_theme_font_size_override("font_size", 14)
	_attach_img_btn.pressed.connect(_on_attach_image_pressed)
	if has_node("%CtxBar"):
		get_node("%CtxBar").add_child(_attach_img_btn)

	# ── 图片预览区域 ──
	_img_preview = HBoxContainer.new()
	_img_preview.add_theme_constant_override("separation", 6)
	_img_preview.visible = false
	if has_node("%CtxBar"):
		get_node("%CtxBar").get_parent().add_child(_img_preview)
		# Move preview before RefList area
		get_node("%CtxBar").get_parent().move_child(_img_preview, 1)

	# ── 供应商选择按钮 ──
	if _provider_btn:
		_provider_btn.clear()
		_provider_btn.add_item("选择大模型代理商...", 0)
		_provider_btn.set_item_disabled(0, true)
		_provider_btn.add_item("硅基流动 (SiliconFlow)", 1)
		_provider_btn.add_item("OpenRouter", 2)
		_provider_btn.add_item("小米 (Xiaomi MiMo)", 3)
		_provider_btn.add_item("智谱 (Z.ai)", 4)
		
		# 使下拉菜单宽度自适应
		var popup = _provider_btn.get_popup()
		if popup:
			for i in range(popup.get_item_count()):
				popup.set_item_as_radio_checkable(i, false)
				popup.set_item_as_checkable(i, false)
		
		_provider_btn.select(0)
		if not _provider_btn.item_selected.is_connected(_on_provider_selected):
			_provider_btn.item_selected.connect(_on_provider_selected)

	# ── 文件选择器 ──
	_img_dialog = FileDialog.new()
	_img_dialog.file_mode = FileDialog.FILE_MODE_OPEN_FILE
	_img_dialog.access = FileDialog.ACCESS_FILESYSTEM
	_img_dialog.filters = PackedStringArray(["*.png ; PNG Images", "*.jpg, *.jpeg ; JPEG Images", "*.webp ; WebP Images", "*.bmp ; BMP Images"])
	_img_dialog.title = _tr("attach_image")
	_img_dialog.size = Vector2i(600, 400)
	_img_dialog.file_selected.connect(_on_image_file_selected)
	add_child(_img_dialog)


func _on_provider_selected(index: int) -> void:
	if index == 1:
		_current_provider = "siliconflow"
	elif index == 2:
		_current_provider = "openrouter"
	elif index == 3:
		_current_provider = "xiaomi"
	elif index == 4:
		_current_provider = "zai"
	else:
		return
	
	if _model_select_btn:
		_model_select_btn.clear()
		_model_select_btn.add_item("Loading models...", 0)
		_model_select_btn.disabled = true
	
	var existing_key = _auth.get_api_key(_current_provider) if _auth else ""
	if existing_key == "":
		_api_key_dialog.popup_centered()
	else:
		_validate_and_fetch_models(existing_key, _current_provider)



func _on_api_key_submitted() -> void:
	var key = _api_key_input.text.strip_edges()
	if key == "": return
	
	if _current_provider == "":
		_current_provider = "openrouter"
	
	_add_bubble(MessageBubble.Role.SYSTEM_EVENT, "Validating API Key for " + _current_provider + "...")
	_validate_and_fetch_models(key, _current_provider)


func _open_settings() -> void:
	if _auth:
		_sf_input.text = _auth.get_api_key("siliconflow")
		_or_input.text = _auth.get_api_key("openrouter")
		_xm_input.text = _auth.get_api_key("xiaomi")
		_zai_input.text = _auth.get_api_key("zai")
	_settings_dialog.popup_centered()


func _on_settings_confirmed() -> void:
	var sf_key = _sf_input.text.strip_edges()
	var or_key = _or_input.text.strip_edges()
	var xm_key = _xm_input.text.strip_edges()
	var zai_key = _zai_input.text.strip_edges()
	
	if _auth:
		_auth.set_api_key(sf_key, "siliconflow")
		_auth.set_api_key(or_key, "openrouter")
		_auth.set_api_key(xm_key, "xiaomi")
		_auth.set_api_key(zai_key, "zai")
		
		# 如果当前选中的 Provider 的 Key 发生了变化，尝试重新拉取模型
		if _current_provider == "siliconflow" and sf_key != "":
			_validate_and_fetch_models(sf_key, "siliconflow")
		elif _current_provider == "openrouter" and or_key != "":
			_validate_and_fetch_models(or_key, "openrouter")
		elif _current_provider == "xiaomi" and xm_key != "":
			_validate_and_fetch_models(xm_key, "xiaomi")
		elif _current_provider == "zai" and zai_key != "":
			_validate_and_fetch_models(zai_key, "zai")
			
		_add_bubble(MessageBubble.Role.SYSTEM_EVENT, _tr("api_key_saved"))

func _validate_and_fetch_models(key: String, provider: String) -> void:
	if provider == "openrouter":
		var url = "https://openrouter.ai/api/v1/auth/key"
		var http := HTTPRequest.new()
		add_child(http)
		http.request_completed.connect(_on_openrouter_auth_checked.bind(http, key, provider))
		http.request(url, ["Authorization: Bearer " + key], HTTPClient.METHOD_GET)
	elif provider == "siliconflow":
		var url = "https://api.siliconflow.cn/v1/models"
		var http := HTTPRequest.new()
		add_child(http)
		http.request_completed.connect(_on_models_fetched.bind(http, key, provider))
		http.request(url, ["Authorization: Bearer " + key], HTTPClient.METHOD_GET)
	elif provider == "xiaomi":
		var is_token_plan = key.begins_with("tp-")
		var base_url = "https://token-plan-cn.xiaomimimo.com/v1" if is_token_plan else "https://api.xiaomimimo.com/v1"
		var url = base_url + "/models"
		var http := HTTPRequest.new()
		add_child(http)
		http.request_completed.connect(_on_models_fetched.bind(http, key, provider))
		http.request(url, ["Authorization: Bearer " + key], HTTPClient.METHOD_GET)
	elif provider == "zai":
		# Z.ai International Station
		var url = "https://api.z.ai/api/paas/v4/models"
		var http := HTTPRequest.new()
		add_child(http)
		http.request_completed.connect(_on_models_fetched.bind(http, key, provider))
		http.request(url, ["Authorization: Bearer " + key], HTTPClient.METHOD_GET)
	else:
		pass

func _on_openrouter_auth_checked(result: int, code: int, headers: PackedStringArray, body: PackedByteArray, http: HTTPRequest, key: String, provider: String) -> void:
	http.queue_free()
	
	if provider != _current_provider:
		return
		
	# Only fail if it's explicitly Unauthorized (401) or Forbidden (403)
	if result == HTTPRequest.RESULT_SUCCESS and code != 401 and code != 403 and code != 0:
		# Valid key, now fetch models
		var url = "https://openrouter.ai/api/v1/models"
		var http_models := HTTPRequest.new()
		add_child(http_models)
		http_models.request_completed.connect(_on_models_fetched.bind(http_models, key, provider))
		http_models.request(url, ["Authorization: Bearer " + key], HTTPClient.METHOD_GET)
		return
	
	if _provider_btn:
		_provider_btn.add_theme_color_override("font_color", Color(0.9, 0.2, 0.2)) # Red
		_provider_btn.add_theme_color_override("font_hover_color", Color(0.9, 0.2, 0.2))
	_add_bubble(MessageBubble.Role.AI, "[img=16]res://addons/godot_maker/icons/ui/triangle-alert.svg[/img] OpenRouter API Key Validation Failed! Please check your key.")

func _on_models_fetched(result: int, code: int, headers: PackedStringArray, body: PackedByteArray, http: HTTPRequest, key: String, provider: String) -> void:
	http.queue_free()
	
	# Race condition check: Only update if the result is for the currently selected provider
	if provider != _current_provider:
		return
		
	if result == HTTPRequest.RESULT_SUCCESS and code == 200:
		var json = JSON.parse_string(body.get_string_from_utf8())
		if typeof(json) == TYPE_DICTIONARY and json.has("data"):
			var models = json["data"]
			_populate_models(models)
			_handle_valid_key(key, provider)
			return
	if _provider_btn:
		_provider_btn.add_theme_color_override("font_color", Color(0.9, 0.2, 0.2)) # Red
		_provider_btn.add_theme_color_override("font_hover_color", Color(0.9, 0.2, 0.2))
	
	# Fallback logic: Only use fallback if it's not a clear authentication error
	if code == 401 or code == 403:
		_add_bubble(MessageBubble.Role.AI, "[img=16]res://addons/godot_maker/icons/ui/triangle-alert.svg[/img] API Key Validation Failed (Error %d)! Please check your key." % code)
		if _provider_btn:
			_provider_btn.add_theme_color_override("font_color", Color(0.9, 0.2, 0.2)) # Red
			_provider_btn.add_theme_color_override("font_hover_color", Color(0.9, 0.2, 0.2))
		return

	if provider == "xiaomi":
		var fallback_models = [
			{"id": "MiMo-V2.5 Pro"},
			{"id": "MiMo-V2.5"},
			{"id": "MiMo-V2 Pro"},
			{"id": "MiMo-V2-Omni"},
			{"id": "MiMo-V2-Flash"}
		]
		_populate_models(fallback_models)
		_handle_valid_key(key, provider)
		return
	elif provider == "zai":
		var fallback_models = [
			{"id": "glm-5.1"},
			{"id": "glm-5"},
			{"id": "glm-5-turbo"},
			{"id": "glm-4.7"},
			{"id": "glm-4.7-flash"},
			{"id": "glm-4.6"},
			{"id": "glm-4.5"},
			{"id": "glm-4.5-air"},
			{"id": "glm-4.5-flash"},
			{"id": "glm-5v-turbo"},
			{"id": "glm-4.6v"},
			{"id": "autoglm-phone-multilingual"}
		]
		_populate_models(fallback_models)
		_handle_valid_key(key, provider)
		return

	_add_bubble(MessageBubble.Role.AI, "[img=16]res://addons/godot_maker/icons/ui/triangle-alert.svg[/img] API Key Validation Failed! Please check your key.")

func _populate_models(models: Array) -> void:
	if not _model_select_btn: return
	_model_select_btn.clear()
	_model_select_btn.show()
	_model_select_btn.disabled = false
	for i in range(models.size()):
		var m = models[i]
		var m_id = m.get("id", "")
		var display_name = m_id.split("/")[-1] if "/" in m_id else m_id
		_model_select_btn.add_item(display_name, i)
		_model_select_btn.set_item_metadata(i, m_id)
		
	var es := EditorInterface.get_editor_settings()
	var saved_model_key = "ksanadock/model_" + _current_provider
	var saved_model = es.get_setting(saved_model_key) if es.has_setting(saved_model_key) else ""
	
	_selected_model = ""
	var match_idx = -1
	for i in range(_model_select_btn.get_item_count()):
		if _model_select_btn.get_item_metadata(i) == saved_model:
			match_idx = i
			break
			
	if match_idx != -1:
		_model_select_btn.select(match_idx)
		_selected_model = saved_model
	elif models.size() > 0:
		_model_select_btn.select(0)
		_selected_model = models[0].get("id", "")
		
	if not _model_select_btn.item_selected.is_connected(_on_model_selected):
		_model_select_btn.item_selected.connect(_on_model_selected)

func _on_model_selected(index: int) -> void:
	_selected_model = _model_select_btn.get_item_metadata(index)
	var es := EditorInterface.get_editor_settings()
	es.set_setting("ksanadock/model_" + _current_provider, _selected_model)

func _handle_valid_key(key: String, provider: String) -> void:
	if _provider_btn:
		_provider_btn.add_theme_color_override("font_color", Color(0.2, 0.9, 0.2)) # Green
		_provider_btn.add_theme_color_override("font_hover_color", Color(0.2, 0.9, 0.2))
	if _auth:
		_auth.set_api_key(key, provider)
		
		var es := EditorInterface.get_editor_settings()
		es.set_setting("ksanadock/ai_provider", provider)
		
		_add_bubble(MessageBubble.Role.SYSTEM_EVENT, "API key validated and saved.")
		api_key_saved.emit()
		
		if _bridge and _bridge.has_method("restart_service"):
			_bridge.restart_service()


func _gui_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed:
		if event.ctrl_pressed and event.keycode == KEY_L:
			_clear_chat()
			accept_event()


func _input(event: InputEvent) -> void:
	if not _input_field or not _input_field.has_focus():
		return
	if event is InputEventKey and event.pressed:
		if event.keycode == KEY_ENTER and not event.shift_pressed:
			_send_message()
			get_viewport().set_input_as_handled()
		elif event.keycode == KEY_V and event.ctrl_pressed:
			# Try to paste image from clipboard
			_try_paste_clipboard_image()


func _send_message() -> void:
	if _is_streaming:
		return
	var text := _input_field.text.strip_edges()
	if text == "" and _context_refs.is_empty() and _pending_images.is_empty():
		return

	# 保存原始提问用于 UI 显示
	var display_text = text
	
	# 构建上下文内容用于发送给 AI
	var full_context = ""
	for ref in _context_refs:
		if ref.type == "file":
			full_context += "[Context File: %s]\n" % ref.data
		elif ref.type == "text":
			full_context += "[Context Reference]:\n%s\n" % ref.data
		elif ref.type == "scene":
			full_context += "[Scene Tree Context]:\n%s\n" % ref.data
		elif ref.type == "code":
			var meta = ref.get("meta", {})
			var file = meta.get("file", "unknown")
			var fl = meta.get("from_line", 0)
			var tl = meta.get("to_line", 0)
			full_context += "[Code Reference: %s (lines %d-%d)]\n```gdscript\n%s\n```\n" % [file, fl, tl, ref.data]
	
	var ai_text = text
	if full_context != "":
		ai_text = "--- Context References ---\n" + full_context + "\n--- User Question ---\n" + text

	# 收集图片数据
	var image_textures: Array = []
	var image_base64s: Array = []
	for img_item in _pending_images:
		image_textures.append(img_item.texture)
		image_base64s.append(img_item.base64)

	# Vision 支持警告
	if not image_base64s.is_empty():
		_add_bubble(MessageBubble.Role.SYSTEM_EVENT, _tr("vision_not_supported"))

	_input_field.text = ""
	# UI 仅显示用户输入的内容，不显示原始上下文
	_pending_user_bubble = _add_bubble_with_images(MessageBubble.Role.USER, display_text, image_textures)
	# 发送给 AI 的内容包含上下文
	_messages.append({"role": "user", "content": ai_text})
	
	_context_refs.clear()
	_update_ref_list()
	_pending_images.clear()
	_update_img_preview()

	_is_streaming = true
	_send_btn.disabled = true

	if not _bridge and EditorInterface.get_base_control().has_meta("ksanadock_bridge"):
		set_bridge(EditorInterface.get_base_control().get_meta("ksanadock_bridge"))

	if _bridge and _bridge.has_method("send_chat_to_agent"):
		var api_key = _auth.get_api_key(_current_provider) if _auth else ""
		_bridge.send_chat_to_agent(text, _on_bridge_response, false, _current_provider, _selected_model, api_key, image_base64s)
	else:
		_on_stream_done(_tr("not_connected"))


func add_context_reference(type: String, data: String, meta: Dictionary = {}) -> void:
	# 去重复
	for ref in _context_refs:
		if ref.type == type and ref.data == data:
			return
	
	var label = data
	if type == "file":
		label = data.get_file()
	elif type == "text":
		label = data.left(15) + "..."
	elif type == "scene":
		label = "Scene: " + meta.get("name", "Tree")
	elif type == "code":
		# Cursor 风格： filename.gd:11-15
		var fname = meta.get("file", "").get_file()
		var fl = meta.get("from_line", 0)
		var tl = meta.get("to_line", 0)
		label = "%s:%d-%d" % [fname if fname != "" else "code", fl, tl]
	
	_context_refs.append({"type": type, "data": data, "label": label, "meta": meta})
	_update_ref_list()


func _update_ref_list() -> void:
	if not _ref_list: return
	for c in _ref_list.get_children():
		c.queue_free()
	
	for i in range(_context_refs.size()):
		var ref = _context_refs[i]
		var btn := Button.new()
		var icon = "📄 "
		match ref.type:
			"file": icon = "📄 "
			"code": icon = "💻 "
			"scene": icon = "🌲 "
			"text": icon = "📝 "
		
		btn.text = icon + ref.label + " ✕"
		btn.add_theme_font_size_override("font_size", 10)
		btn.pressed.connect(_on_ref_remove_btn_pressed.bind(i))
		_ref_list.add_child(btn)


func _on_ref_remove_btn_pressed(idx: int) -> void:
	if idx < _context_refs.size():
		_context_refs.remove_at(idx)
		_update_ref_list()


func _grab_output_selection() -> void:
	var output_rtc = _find_output_log(EditorInterface.get_base_control())
	if output_rtc and not output_rtc.get_selected_text().is_empty():
		add_context_reference("text", output_rtc.get_selected_text())
	else:
		var clip = DisplayServer.clipboard_get()
		if clip != "":
			add_context_reference("text", clip)


func _find_output_log(node: Node) -> RichTextLabel:
	if node is RichTextLabel and (node.name.to_lower().contains("log") or node.name.to_lower().contains("filter")):
		return node
	for child in node.get_children():
		var res = _find_output_log(child)
		if res: return res
	return null


func _on_bridge_response(result: Dictionary) -> void:
	if result.has("error"):
		_on_stream_error(str(result.error))
		return
	
	if result.has("checkpoint") and _pending_user_bubble:
		var checkpoint = result.get("checkpoint", {})
		if checkpoint is Dictionary and checkpoint.get("id", "") != "":
			if _pending_user_bubble.has_method("set_checkpoint"):
				_pending_user_bubble.set_checkpoint(checkpoint.get("id", ""))
			if not _pending_user_bubble.rollback_requested.is_connected(_on_message_rollback_requested):
				_pending_user_bubble.rollback_requested.connect(_on_message_rollback_requested)
			if not _messages.is_empty():
				_messages[_messages.size() - 1]["checkpoint"] = checkpoint
		_pending_user_bubble = null
	
	var type = result.get("type", "text")
	if type == "plan":
		_add_plan_bubble(result.get("data", {}), result.get("tool_call_id", ""))
	else:
		# Text task acknowledgment received, but we only stop streaming when process_end or reply arrives
		# However, if the agent doesn't even start processing, we should unlock the UI
		pass


func _add_plan_bubble(data: Dictionary, tool_call_id: String) -> void:
	_is_streaming = false
	_send_btn.disabled = false
	if _current_bubble:
		_current_bubble.queue_free()
		_current_bubble = null
	var bubble := VBoxContainer.new()
	bubble.set_script(MessageBubble)
	bubble.setup_plan(data.get("title", ""), data.get("steps", []))
	_msg_list.add_child(bubble)
	bubble.plan_approved.connect(_on_plan_approved)
	_scroll_to_bottom()


func _add_resume_prompt_bubble(task_count: int) -> void:
	var bubble := VBoxContainer.new()
	bubble.set_script(MessageBubble)
	bubble.setup_resume_prompt(task_count)
	_msg_list.add_child(bubble)
	bubble.resume_requested.connect(_on_resume_requested.bind(bubble))
	_scroll_to_bottom()


func _on_resume_requested(bubble: Node) -> void:
	bubble.queue_free()
	var msg = "继续执行之前的任务"
	_send_direct_message(msg, true)


func _on_plan_approved(auto_run: bool) -> void:
	var msg = _tr("plan_full") if auto_run else _tr("plan_step")
	_send_direct_message(msg, auto_run)


func _send_direct_message(text: String, auto_run: bool = false) -> void:
	_add_bubble(MessageBubble.Role.USER, text)
	_messages.append({"role": "user", "content": text})
	_is_streaming = true
	_send_btn.disabled = true
	if not _bridge and EditorInterface.get_base_control().has_meta("ksanadock_bridge"):
		set_bridge(EditorInterface.get_base_control().get_meta("ksanadock_bridge"))

	if _bridge and _bridge.has_method("send_chat_to_agent"):
		var api_key = _auth.get_api_key(_current_provider) if _auth else ""
		_bridge.send_chat_to_agent(text, _on_bridge_response, auto_run, _current_provider, _selected_model, api_key)


func set_bridge(bridge: Node) -> void:
	_bridge = bridge
	if _bridge.has_signal("agent_event") and not _bridge.agent_event.is_connected(_on_agent_event):
		_bridge.agent_event.connect(_on_agent_event)
	if _bridge.has_signal("agent_reply") and not _bridge.agent_reply.is_connected(_on_agent_reply):
		_bridge.agent_reply.connect(_on_agent_reply)
	if _bridge.has_signal("agent_connected") and not _bridge.agent_connected.is_connected(_on_agent_connected):
		_bridge.agent_connected.connect(_on_agent_connected)
	if _bridge.has_signal("file_created") and not _bridge.file_created.is_connected(_on_file_created):
		_bridge.file_created.connect(_on_file_created)
	
	# 如果 bridge 已经连接，直接刷新历史
	if _bridge.has_method("get_agent_history"):
		if _bridge.has_method("is_agent_connected") and _bridge.is_agent_connected():
			_bridge.get_agent_history(_render_history)


func _on_file_change_reviewed(file_path: String, accepted: bool) -> void:
	if not accepted:
		_add_bubble(MessageBubble.Role.SYSTEM_EVENT, "已拒绝并丢弃对 " + file_path.get_file() + " 的改动。")
		return
	
	if _bridge and _bridge.has_method("apply_file_change"):
		_bridge.apply_file_change(file_path)
		_add_bubble(MessageBubble.Role.SYSTEM_EVENT, "成功应用改动至 " + file_path.get_file())
	else:
		_add_bubble(MessageBubble.Role.SYSTEM_EVENT, "错误：Bridge 无法应用改动。")


func _on_file_created(path: String) -> void:
	# 读取新文件内容进行展示
	var content = ""
	if FileAccess.file_exists(path):
		var f = FileAccess.open(path, FileAccess.READ)
		if f:
			content = f.get_as_text()
			f.close()
	
	_add_file_diff_bubble(path, content)


func _on_agent_connected() -> void:
	print("[GodotMaker] Agent connected signal received in Chat UI. Requesting history...")
	if _bridge and _bridge.has_method("get_agent_history"):
		_bridge.get_agent_history(_render_history)
	
	# 新增：检查是否有未完成的任务
	if _bridge and _bridge.has_method("call_agent_method"):
		_bridge.call_agent_method("check_unfinished_tasks", {}, _on_tasks_checked)


func _on_tasks_checked(result: Dictionary) -> void:
	if result.has("error"): return
	if result.get("has_unfinished", false):
		_add_resume_prompt_bubble(result.get("task_count", 0))


func _create_rollback_dialog() -> void:
	if _rollback_dialog:
		return
	_rollback_dialog = AcceptDialog.new()
	_rollback_dialog.title = "Session Rollback"
	_rollback_dialog.size = Vector2i(760, 520)
	_rollback_dialog.get_ok_button().text = "Close"
	add_child(_rollback_dialog)
	
	var root := VBoxContainer.new()
	root.add_theme_constant_override("separation", 10)
	_rollback_dialog.add_child(root)
	
	var split := HSplitContainer.new()
	split.size_flags_vertical = Control.SIZE_EXPAND_FILL
	root.add_child(split)
	
	_rollback_list = ItemList.new()
	_rollback_list.custom_minimum_size = Vector2(260, 360)
	_rollback_list.item_selected.connect(_on_rollback_selected)
	split.add_child(_rollback_list)
	
	_rollback_detail = RichTextLabel.new()
	_rollback_detail.bbcode_enabled = true
	_rollback_detail.fit_content = false
	_rollback_detail.scroll_active = true
	_rollback_detail.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_rollback_detail.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_rollback_detail.size_flags_vertical = Control.SIZE_EXPAND_FILL
	split.add_child(_rollback_detail)
	
	var actions := HBoxContainer.new()
	actions.alignment = BoxContainer.ALIGNMENT_END
	root.add_child(actions)
	
	_rollback_restore_btn = Button.new()
	_rollback_restore_btn.text = "Restore selected checkpoint"
	_rollback_restore_btn.disabled = true
	_rollback_restore_btn.add_theme_stylebox_override("normal", KPalette.btn_primary())
	_rollback_restore_btn.add_theme_stylebox_override("hover", KPalette.btn_primary_hover())
	_rollback_restore_btn.pressed.connect(_restore_selected_checkpoint)
	actions.add_child(_rollback_restore_btn)


func _open_rollback_dialog(checkpoint_id: String = "") -> void:
	if not _bridge or not _bridge.has_method("call_agent_method"):
		_add_bubble(MessageBubble.Role.SYSTEM_EVENT, "Rollback is unavailable: agent bridge is not connected.")
		return
	_selected_checkpoint_id = checkpoint_id
	_rollback_restore_btn.disabled = true
	_rollback_detail.text = "Loading checkpoints..."
	_rollback_list.clear()
	_rollback_dialog.popup_centered()
	if checkpoint_id != "":
		_rollback_restore_btn.disabled = false
		_bridge.call_agent_method("get_session_checkpoint", {"checkpoint_id": checkpoint_id}, _on_rollback_detail_loaded)
	else:
		_bridge.call_agent_method("list_session_checkpoints", {}, _on_rollback_list_loaded)


func _on_message_rollback_requested(checkpoint_id: String) -> void:
	_open_rollback_dialog(checkpoint_id)


func _on_rollback_list_loaded(result: Variant) -> void:
	if result is Dictionary and result.has("error"):
		_rollback_detail.text = "[color=#ef4444]Error:[/color] " + str(result.error)
		return
	
	_rollback_checkpoints = []
	if result is Dictionary:
		_rollback_checkpoints = result.get("checkpoints", [])
	
	_rollback_list.clear()
	if _rollback_checkpoints.is_empty():
		_rollback_detail.text = "No checkpoints for this session yet."
		return
	
	for checkpoint in _rollback_checkpoints:
		if not checkpoint is Dictionary:
			continue
		var label = checkpoint.get("label", "Checkpoint")
		var created = checkpoint.get("createdAt", "")
		var count = checkpoint.get("file_count", 0)
		_rollback_list.add_item("%s\n%s - %s files" % [label, created, count])
	
	_rollback_list.select(0)
	_on_rollback_selected(0)


func _on_rollback_selected(index: int) -> void:
	if index < 0 or index >= _rollback_checkpoints.size():
		return
	var checkpoint = _rollback_checkpoints[index]
	if not checkpoint is Dictionary:
		return
	_selected_checkpoint_id = checkpoint.get("id", "")
	_rollback_restore_btn.disabled = _selected_checkpoint_id == ""
	_rollback_detail.text = "Loading checkpoint details..."
	_bridge.call_agent_method("get_session_checkpoint", {"checkpoint_id": _selected_checkpoint_id}, _on_rollback_detail_loaded)


func _on_rollback_detail_loaded(result: Variant) -> void:
	if result is Dictionary and result.has("error"):
		_rollback_detail.text = "[color=#ef4444]Error:[/color] " + str(result.error)
		return
	if not result is Dictionary:
		_rollback_detail.text = "Invalid checkpoint details."
		return
	
	var lines: Array[String] = []
	lines.append("[b]%s[/b]" % result.get("label", "Checkpoint"))
	lines.append("Created: %s" % result.get("createdAt", ""))
	lines.append("Files: %s" % result.get("file_count", 0))
	lines.append("")
	
	var summary: Dictionary = result.get("summary", {})
	if not summary.is_empty():
		lines.append("[b]Current workspace state[/b]")
		for key in summary.keys():
			lines.append("- %s: %s" % [key, summary[key]])
		lines.append("")
	
	var files: Array = result.get("files", [])
	if not files.is_empty():
		lines.append("[b]Changed files[/b]")
		var shown := 0
		for file in files:
			if not file is Dictionary:
				continue
			var status = file.get("status", "")
			if status == "unchanged" or status == "still_missing":
				continue
			lines.append("- [code]%s[/code] - %s" % [file.get("path", ""), status])
			shown += 1
			if shown >= 80:
				lines.append("- ...")
				break
		if shown == 0:
			lines.append("No changed files relative to this checkpoint.")
	
	_rollback_detail.text = "\n".join(lines)


func _restore_selected_checkpoint() -> void:
	if _selected_checkpoint_id == "":
		return
	_rollback_restore_btn.disabled = true
	_rollback_restore_btn.text = "Restoring..."
	_bridge.call_agent_method("restore_session_checkpoint", {"checkpoint_id": _selected_checkpoint_id}, _on_checkpoint_restored)


func _on_checkpoint_restored(result: Variant) -> void:
	_rollback_restore_btn.text = "Restore selected checkpoint"
	if result is Dictionary and result.has("error"):
		_rollback_restore_btn.disabled = false
		_rollback_detail.text += "\n\n[color=#ef4444]Restore failed:[/color] " + str(result.error)
		return
	
	var restored_count := 0
	var skipped_count := 0
	if result is Dictionary:
		restored_count = result.get("restored", []).size()
		skipped_count = result.get("skipped", []).size()
	
	_add_bubble(MessageBubble.Role.SYSTEM_EVENT, "Restored checkpoint. Files restored: %d, skipped: %d." % [restored_count, skipped_count])
	_rollback_dialog.hide()
	if Engine.is_editor_hint():
		EditorInterface.get_resource_filesystem().scan()


func _render_history(history_data: Variant) -> void:
	var history: Array = []
	if history_data is Array:
		history = history_data
	elif history_data is Dictionary:
		history = [history_data]
	else:
		return
		
	if history.is_empty():
		return
		
	for c in _msg_list.get_children():
		c.queue_free()
	_messages.clear()
	
	for msg in history:
		if not msg is Dictionary: continue
		var role_str = msg.get("role", "")
		var content = msg.get("content", "")
		
		if role_str == "assistant":
			# 渲染工具调用（显示为齿轮气泡，匹配实时体验）
			if msg.has("tool_calls") and msg["tool_calls"] is Array:
				for tc in msg["tool_calls"]:
					if not tc is Dictionary: continue
					var fn = tc.get("function", {})
					var name = fn.get("name", "unknown")
					var args = fn.get("arguments", "{}")
					_add_bubble(MessageBubble.Role.TOOL_EXEC, _tr("tool_executing") % [name, args])
			
			# 渲染文本回复
			if content != "":
				_add_bubble(MessageBubble.Role.AI, content)
			
			# 保存到上下文记录
			var assistant_msg = {"role": "assistant", "content": content}
			if msg.has("tool_calls"):
				assistant_msg["tool_calls"] = msg["tool_calls"]
			_messages.append(assistant_msg)
				
		elif role_str == "user":
			var bubble = _add_bubble(MessageBubble.Role.USER, content)
			var user_msg = {"role": "user", "content": content}
			if msg.has("checkpoint") and msg["checkpoint"] is Dictionary:
				var checkpoint = msg["checkpoint"]
				user_msg["checkpoint"] = checkpoint
				if bubble and checkpoint.get("id", "") != "":
					bubble.set_checkpoint(checkpoint.get("id", ""))
					if not bubble.rollback_requested.is_connected(_on_message_rollback_requested):
						bubble.rollback_requested.connect(_on_message_rollback_requested)
			_messages.append(user_msg)
			
		elif role_str == "tool":
			# 渲染工具执行结果
			var tool_name = msg.get("name", "")
			var display_text = content
			if tool_name != "":
				display_text = _tr("tool_result") % [tool_name, content]
			_add_bubble(MessageBubble.Role.TOOL_EXEC, display_text)
			
			# 保存到上下文记录
			var tool_msg = {"role": "tool", "content": content}
			if msg.has("tool_call_id"): tool_msg["tool_call_id"] = msg["tool_call_id"]
			if tool_name != "": tool_msg["name"] = tool_name
			_messages.append(tool_msg)
	
	_scroll_to_bottom()


func _on_agent_event(params: Dictionary) -> void:
	var event_type = params.get("type", "")
	var msg = params.get("message", "")
	var agent_id = params.get("agentId", "")
	
	if event_type == "process_start":
		_ensure_thinking(msg)
		_is_streaming = true
		_send_btn.disabled = true
	elif event_type == "tool_execution":
		# 工具执行现在直接更新在 Thinking 状态中，不再增加新的气泡
		_ensure_thinking(msg)
	elif event_type == "error":
		_remove_thinking()
		_on_stream_error(msg)
	elif event_type == "process_end":
		# process_end 不再移除 thinking，因为通常紧接着就是 reply 或已经在 streaming
		# _remove_thinking() 会在收到第一个 chunk 时由 _on_stream_chunk 处理
		pass
	elif event_type == "subagent_start":
		# Subagent 是并行任务，保留其独立展示逻辑，但先移除主 Thinking
		_remove_thinking()
		var bubble := _create_bubble(MessageBubble.Role.SUBAGENT, "")
		bubble.setup_subagent(params.get("title", _tr("bg_task_default")))
		bubble.append_subagent_log(msg)
		_msg_list.add_child(bubble)
		_active_subagents[agent_id] = bubble
		_scroll_to_bottom()
	elif event_type == "subagent_tool":
		var sub_bubble = _active_subagents.get(agent_id)
		if sub_bubble:
			sub_bubble.append_subagent_log(msg)
			_scroll_to_bottom()
	elif event_type == "subagent_end":
		var sub_bubble = _active_subagents.get(agent_id)
		if sub_bubble:
			sub_bubble.append_subagent_log("[color=#4ade80]✔[/color] " + msg)
			_active_subagents.erase(agent_id)
			_scroll_to_bottom()
	elif event_type == "file_change":
		_add_file_diff_bubble(params.get("path", ""), params.get("diff", ""))


func _add_file_diff_bubble(file_path: String, diff_content: String) -> void:
	var bubble := _create_bubble(MessageBubble.Role.FILE_DIFF, "")
	bubble.setup_file_diff(file_path, diff_content)
	bubble.file_change_reviewed.connect(_on_file_change_reviewed)
	_msg_list.add_child(bubble)
	_scroll_to_bottom()


func _on_agent_reply(params: Dictionary) -> void:
	var text = params.get("text", "")
	_remove_thinking()
	
	# 如果已经在 streaming 过程中创建了气泡，直接完成它
	if _current_bubble:
		_on_stream_done(text)
	elif text != "":
		# 否则创建一个新气泡（针对非流式返回）
		_current_bubble = _create_bubble(MessageBubble.Role.AI, "")
		_msg_list.add_child(_current_bubble)
		_on_stream_done(text)


func _on_stream_chunk(text: String) -> void:
	# 关键：当收到第一个数据块时，移除 Thinking 状态并创建正式气泡
	if not _current_bubble:
		_remove_thinking()
		_current_bubble = _create_bubble(MessageBubble.Role.AI, "")
		_msg_list.add_child(_current_bubble)
	
	if _current_bubble:
		_current_bubble.append_text(text)
	_scroll_to_bottom()


func _on_stream_done(full_text: String) -> void:
	_is_streaming = false
	_send_btn.disabled = false
	_messages.append({"role": "assistant", "content": full_text})
	if _current_bubble and _current_bubble.has_method("set_message"):
		_current_bubble.set_message(full_text)
	_current_bubble = null
	_scroll_to_bottom()


func _on_stream_error(message: String) -> void:
	_is_streaming = false
	_send_btn.disabled = false
	_remove_thinking()
	_add_bubble(MessageBubble.Role.AI, "[img=16]res://addons/godot_maker/icons/ui/triangle-alert.svg[/img] Error: %s" % message)
	_current_bubble = null


func _add_bubble(role: int, text: String) -> VBoxContainer:
	var bubble := _create_bubble(role, text)
	if _msg_list:
		_msg_list.add_child(bubble)
	_scroll_to_bottom()
	return bubble


func _create_bubble(role: int, text: String, images: Array = []) -> VBoxContainer:
	var bubble := VBoxContainer.new()
	bubble.set_script(MessageBubble)
	bubble.theme = theme  # 确保气泡使用正确的主题
	bubble.setup(role, text, images)
	return bubble


func _scroll_to_bottom() -> void:
	if not is_inside_tree() or not _scroll: return
	await get_tree().process_frame
	_scroll.scroll_vertical = int(_scroll.get_v_scroll_bar().max_value)


func _clear_chat() -> void:
	if _msg_list:
		for c in _msg_list.get_children():
			c.queue_free()
	_messages.clear()
	_active_subagents.clear()
	_current_bubble = null
	_thinking_indicator = null


func _ensure_thinking(status: String) -> void:
	if not _thinking_indicator:
		var ThinkingIndicator = load("res://addons/godot_maker/ui/chat/thinking_indicator.gd")
		_thinking_indicator = ThinkingIndicator.new()
		
		# 包装一层以处理边距
		var margin := MarginContainer.new()
		margin.add_theme_constant_override("margin_left", 36)
		margin.add_theme_constant_override("margin_top", 4)
		margin.add_theme_constant_override("margin_bottom", 4)
		margin.add_child(_thinking_indicator)
		
		_msg_list.add_child(margin)
	
	_thinking_indicator.set_status(status)
	_scroll_to_bottom()


func _remove_thinking() -> void:
	if _thinking_indicator:
		var parent = _thinking_indicator.get_parent()
		if parent is MarginContainer:
			parent.queue_free()
		else:
			_thinking_indicator.queue_free()
		_thinking_indicator = null





# ======== 图片上传功能 ========

func _add_bubble_with_images(role: int, text: String, images: Array = []) -> VBoxContainer:
	var bubble := _create_bubble(role, text, images)
	if _msg_list:
		_msg_list.add_child(bubble)
	_scroll_to_bottom()
	return bubble


func _on_attach_image_pressed() -> void:
	if _pending_images.size() >= MAX_IMAGE_COUNT:
		_add_bubble(MessageBubble.Role.SYSTEM_EVENT, _tr("too_many_images"))
		return
	_img_dialog.popup_centered()


func _on_image_file_selected(path: String) -> void:
	var img := Image.new()
	var err = img.load(path)
	if err != OK:
		_add_bubble(MessageBubble.Role.SYSTEM_EVENT, "Failed to load image: " + path)
		return
	_add_image_from_godot_image(img)


func _try_paste_clipboard_image() -> void:
	var img := DisplayServer.clipboard_get_image()
	if img == null or img.is_empty():
		# No image in clipboard, let normal text paste proceed
		return
	# We have an image, consume the event to prevent text paste
	get_viewport().set_input_as_handled()
	_add_image_from_godot_image(img)


func _add_image_from_godot_image(img: Image) -> void:
	if _pending_images.size() >= MAX_IMAGE_COUNT:
		_add_bubble(MessageBubble.Role.SYSTEM_EVENT, _tr("too_many_images"))
		return

	# Encode to PNG for base64
	var png_data := img.save_png_to_buffer()
	var size_mb := png_data.size() / (1024.0 * 1024.0)
	if size_mb > MAX_IMAGE_SIZE_MB:
		_add_bubble(MessageBubble.Role.SYSTEM_EVENT, _tr("image_too_large") % size_mb)
		return

	var base64_str := Marshalls.raw_to_base64(png_data)

	# Create texture for preview
	var tex := ImageTexture.create_from_image(img)

	_pending_images.append({"base64": base64_str, "texture": tex})
	_update_img_preview()


func _update_img_preview() -> void:
	if not _img_preview:
		return
	for c in _img_preview.get_children():
		c.queue_free()
	
	_img_preview.visible = not _pending_images.is_empty()
	
	for i in range(_pending_images.size()):
		var item = _pending_images[i]
		var container := VBoxContainer.new()
		container.add_theme_constant_override("separation", 2)
		
		# Thumbnail
		var tex_rect := TextureRect.new()
		tex_rect.texture = item.texture
		tex_rect.custom_minimum_size = Vector2(60, 45)
		tex_rect.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
		tex_rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		container.add_child(tex_rect)
		
		# Remove button
		var remove_btn := Button.new()
		remove_btn.text = "✕"
		remove_btn.add_theme_font_size_override("font_size", 26)
		remove_btn.tooltip_text = _tr("remove_image")
		remove_btn.pressed.connect(_on_remove_image.bind(i))
		container.add_child(remove_btn)
		
		_img_preview.add_child(container)


func _on_remove_image(idx: int) -> void:
	if idx < _pending_images.size():
		_pending_images.remove_at(idx)
		_update_img_preview()
