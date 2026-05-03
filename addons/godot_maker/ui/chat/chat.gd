@tool
extends VBoxContainer
## GodotMaker AI 对话面板（Chat Dock）

const MessageBubble = preload("res://addons/godot_maker/ui/chat/message_bubble.gd")

var _auth: KAuthClient
var _ai_client: KAIClient
var _bridge: Node # The GodotMaker Bridge instance

@onready var _msg_list: VBoxContainer = %MsgList
@onready var _scroll: ScrollContainer = %Scroll
@onready var _input_field: TextEdit = %InputField
@onready var _send_btn: Button = %SendBtn
@onready var _clear_btn: Button = %ClearBtn
@onready var _ctx_scene_btn: Button = %CtxSceneBtn
@onready var _ref_list: HBoxContainer = %RefList
@onready var _input_bg: PanelContainer = $InputBG
@onready var _provider_btn: OptionButton = %ProviderBtn
@onready var _model_select_btn: OptionButton = %ModelSelectBtn
var _current_provider: String = ""
var _selected_model: String = ""

signal login_requested
signal api_key_saved

@onready var _start_overlay: CenterContainer = %StartOverlay
@onready var _start_btn: Button = %StartBtn
@onready var _auth_dialog: AcceptDialog = %AuthDialog
@onready var _api_key_dialog: AcceptDialog = %APIKeyDialog
@onready var _api_key_input: LineEdit = %APIKeyInput
@onready var _settings_btn: Button = %SettingsBtn
@onready var _settings_dialog: AcceptDialog = %SettingsDialog
@onready var _sf_input: LineEdit = %SiliconFlowInput
@onready var _or_input: LineEdit = %OpenRouterInput
var _connect_ksanadock_btn: Button

var _messages: Array[Dictionary] = []  # {role, content}
var _current_bubble: PanelContainer = null
var _is_streaming := false
var _active_subagents: Dictionary = {} # agentId -> MessageBubble
var _context_refs: Array[Dictionary] = [] # {type, data, label}
var _grab_btn: Button
var _input_normal: StyleBoxFlat
var _input_focused: StyleBoxFlat


func _process(_delta: float) -> void:
	if not Engine.is_editor_hint(): return
	
	if _bridge and not is_instance_valid(_bridge):
		_bridge = null
		
	if not _bridge and EditorInterface.get_base_control().has_meta("ksanadock_bridge"):
		set_bridge(EditorInterface.get_base_control().get_meta("ksanadock_bridge"))

func _ready() -> void:
	name = "Chat"
	if _scroll:
		_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	
	KTranslationManager.initialize()
	KTranslationManager.add_listener(_on_locale_changed)
	
	_apply_theme()
	_update_ui_localization()
	_create_auth_ui()
	_connect_signals()
	_check_auth_status()


func _load_persisted_state() -> void:
	var es := EditorInterface.get_editor_settings()
	var saved_provider = es.get_setting("ksanadock/ai_provider") if es.has_setting("ksanadock/ai_provider") else ""
	if saved_provider == "siliconflow":
		if _provider_btn: _provider_btn.select(1)
		_current_provider = "siliconflow"
	elif saved_provider == "openrouter":
		if _provider_btn: _provider_btn.select(2)
		_current_provider = "openrouter"
		
	if _current_provider != "":
		var key = _auth.get_api_key(_current_provider) if _auth else ""
		if key != "":
			_validate_and_fetch_models(key, _current_provider)

func _on_locale_changed(_lang: String) -> void:
	_update_ui_localization()


func _on_input_focus_entered() -> void:
	_input_field.add_theme_stylebox_override("normal", _input_focused)


func _on_input_focus_exited() -> void:
	_input_field.add_theme_stylebox_override("normal", _input_normal)


func initialize(auth: KAuthClient) -> void:
	if _auth == auth: return
	_auth = auth
	_ai_client = KAIClient.new()
	_ai_client.initialize(_auth)
	_ai_client.stream_chunk.connect(_on_stream_chunk)
	_ai_client.stream_done.connect(_on_stream_done)
	_ai_client.stream_error.connect(_on_stream_error)
	
	_check_auth_status()
	_load_persisted_state()
	
	# 欢迎消息
	if _messages.is_empty():
		_add_bubble(MessageBubble.Role.AI, _tr("welcome"))

func _check_auth_status() -> void:
	var authed = false
	if _auth:
		authed = _auth.is_logged_in() or _auth.has_api_key()
	
	if _start_overlay:
		_start_overlay.visible = not authed
	if _input_bg:
		_input_bg.visible = authed


func _apply_theme() -> void:
	if not _send_btn: return
	_send_btn.add_theme_stylebox_override("normal", KPalette.btn_primary())
	_send_btn.add_theme_stylebox_override("hover", KPalette.btn_primary_hover())
	_send_btn.add_theme_stylebox_override("pressed", KPalette.btn_primary_pressed())
	_send_btn.add_theme_color_override("font_color", KPalette.TEXT_PRIMARY)
	
	_clear_btn.add_theme_stylebox_override("normal", KPalette.btn_secondary())
	_clear_btn.add_theme_stylebox_override("hover", KPalette.btn_secondary_hover())
	
	_ctx_scene_btn.add_theme_stylebox_override("normal", KPalette.btn_secondary())
	_ctx_scene_btn.add_theme_stylebox_override("hover", KPalette.btn_secondary_hover())

	_settings_btn.add_theme_stylebox_override("normal", KPalette.btn_secondary())
	_settings_btn.add_theme_stylebox_override("hover", KPalette.btn_secondary_hover())

	_input_normal = KPalette.input_style_normal()
	_input_focused = KPalette.input_style_focused()
	_input_field.add_theme_stylebox_override("normal", _input_normal)
	_input_field.add_theme_color_override("font_color", KPalette.TEXT_PRIMARY)
	_input_field.add_theme_color_override("font_placeholder_color", KPalette.TEXT_DIM)
	
	_input_field.focus_entered.connect(_on_input_focus_entered)
	_input_field.focus_exited.connect(_on_input_focus_exited)


func _tr(key: String) -> String:
	return KTranslationManager.get_text("chat", key)


func _update_ui_localization() -> void:
	if _grab_btn:
		_grab_btn.text = _tr("grab_output")
	if _start_btn:
		_start_btn.text = _tr("start_creating")
	if _auth_dialog:
		_auth_dialog.title = _tr("choose_auth_method")
		_auth_dialog.get_ok_button().text = _tr("input_api_key")
		if _connect_ksanadock_btn:
			_connect_ksanadock_btn.text = _tr("connect_ksanadock")
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

	# 如果只有一条欢迎消息，则尝试刷新欢迎消息的语言
	if _messages.is_empty() and _msg_list.get_child_count() == 1:
		var first = _msg_list.get_child(0)
		if first.has_method("set_message"):
			first.set_message(_tr("welcome"))


func _connect_signals() -> void:
	_send_btn.pressed.connect(_send_message)
	_clear_btn.pressed.connect(_clear_chat)
	_ctx_scene_btn.pressed.connect(_attach_scene_context)
	_settings_btn.pressed.connect(_open_settings)
	_settings_dialog.confirmed.connect(_on_settings_confirmed)
	
	_grab_btn = Button.new()
	_grab_btn.text = _tr("grab_output")
	_grab_btn.add_theme_font_size_override("font_size", 11)
	_grab_btn.add_theme_stylebox_override("normal", KPalette.btn_secondary())
	_grab_btn.pressed.connect(_grab_output_selection)
	if has_node("%CtxBar"):
		get_node("%CtxBar").add_child(_grab_btn)

func _create_auth_ui() -> void:
	if not _auth_dialog: return
	
	# 设置独占/瞬态属性
	_auth_dialog.transient = true
	_auth_dialog.exclusive = true
	_api_key_dialog.transient = true
	_api_key_dialog.exclusive = true
	
	# 添加连接按钮并保存引用 (防止 @tool 下重复添加)
	if _connect_ksanadock_btn == null:
		_connect_ksanadock_btn = _auth_dialog.add_button("", true, "connect")
	
	if not _auth_dialog.confirmed.is_connected(_on_api_key_choice):
		_auth_dialog.confirmed.connect(_on_api_key_choice)
	if not _auth_dialog.custom_action.is_connected(_on_auth_custom_action):
		_auth_dialog.custom_action.connect(_on_auth_custom_action)
	
	if not _api_key_dialog.confirmed.is_connected(_on_api_key_submitted):
		_api_key_dialog.confirmed.connect(_on_api_key_submitted)
	
	if not _start_btn.pressed.is_connected(_on_start_pressed):
		_start_btn.pressed.connect(_on_start_pressed)
		
	if _provider_btn:
		_provider_btn.clear()
		_provider_btn.add_item("选择大模型代理商...", 0)
		_provider_btn.set_item_disabled(0, true)
		_provider_btn.add_item("硅基流动 (SiliconFlow)", 1)
		_provider_btn.add_item("OpenRouter", 2)
		
		# Remove radio circles from popup items
		var popup = _provider_btn.get_popup()
		for i in range(popup.get_item_count()):
			popup.set_item_as_radio_checkable(i, false)
			popup.set_item_as_checkable(i, false)
			
		_provider_btn.select(0)
		if not _provider_btn.item_selected.is_connected(_on_provider_selected):
			_provider_btn.item_selected.connect(_on_provider_selected)
	
	_update_ui_localization()

func _on_provider_selected(index: int) -> void:
	if index == 1:
		_current_provider = "siliconflow"
	elif index == 2:
		_current_provider = "openrouter"
	else:
		return
	
	var existing_key = _auth.get_api_key(_current_provider) if _auth else ""
	if existing_key == "":
		_api_key_dialog.popup_centered()
	else:
		_validate_and_fetch_models(existing_key, _current_provider)


func _on_auth_custom_action(action: String) -> void:
	if action == "connect":
		_auth_dialog.hide()
		_on_ksanadock_choice()

func _on_start_pressed() -> void:
	_auth_dialog.popup_centered()

func _on_api_key_choice() -> void:
	_api_key_dialog.popup_centered()

func _on_ksanadock_choice() -> void:
	login_requested.emit()

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
	_settings_dialog.popup_centered()


func _on_settings_confirmed() -> void:
	var sf_key = _sf_input.text.strip_edges()
	var or_key = _or_input.text.strip_edges()
	
	if _auth:
		_auth.set_api_key(sf_key, "siliconflow")
		_auth.set_api_key(or_key, "openrouter")
		
		# 如果当前选中的 Provider 的 Key 发生了变化，尝试重新拉取模型
		if _current_provider == "siliconflow" and sf_key != "":
			_validate_and_fetch_models(sf_key, "siliconflow")
		elif _current_provider == "openrouter" and or_key != "":
			_validate_and_fetch_models(or_key, "openrouter")
			
		_add_bubble(MessageBubble.Role.SYSTEM_EVENT, _tr("api_key_saved"))

func _validate_and_fetch_models(key: String, provider: String) -> void:
	if provider == "openrouter":
		var url = "https://openrouter.ai/api/v1/auth/key"
		var http := HTTPRequest.new()
		add_child(http)
		http.request_completed.connect(_on_openrouter_auth_checked.bind(http, key, provider))
		http.request(url, ["Authorization: Bearer " + key], HTTPClient.METHOD_GET)
	else:
		var url = "https://api.siliconflow.cn/v1/models"
		var http := HTTPRequest.new()
		add_child(http)
		http.request_completed.connect(_on_models_fetched.bind(http, key, provider))
		http.request(url, ["Authorization: Bearer " + key], HTTPClient.METHOD_GET)

func _on_openrouter_auth_checked(result: int, code: int, headers: PackedStringArray, body: PackedByteArray, http: HTTPRequest, key: String, provider: String) -> void:
	http.queue_free()
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
	_add_bubble(MessageBubble.Role.AI, "[img=16]res://addons/godot_maker/icons/ui/triangle-alert.svg[/img] OpenRouter API Key Validation Failed! Please check your key.")

func _on_models_fetched(result: int, code: int, headers: PackedStringArray, body: PackedByteArray, http: HTTPRequest, key: String, provider: String) -> void:
	http.queue_free()
	if result == HTTPRequest.RESULT_SUCCESS and code == 200:
		var json = JSON.parse_string(body.get_string_from_utf8())
		if typeof(json) == TYPE_DICTIONARY and json.has("data"):
			var models = json["data"]
			_populate_models(models)
			_handle_valid_key(key, provider)
			return
	if _provider_btn:
		_provider_btn.add_theme_color_override("font_color", Color(0.9, 0.2, 0.2)) # Red
	_add_bubble(MessageBubble.Role.AI, "[img=16]res://addons/godot_maker/icons/ui/triangle-alert.svg[/img] API Key Validation Failed! Please check your key.")

func _populate_models(models: Array) -> void:
	if not _model_select_btn: return
	_model_select_btn.clear()
	_model_select_btn.show()
	for i in range(models.size()):
		var m = models[i]
		var m_id = m.get("id", "")
		_model_select_btn.add_item(m_id, i)
		
	var es := EditorInterface.get_editor_settings()
	var saved_model_key = "ksanadock/model_" + _current_provider
	var saved_model = es.get_setting(saved_model_key) if es.has_setting(saved_model_key) else ""
	
	_selected_model = ""
	var match_idx = -1
	for i in range(_model_select_btn.get_item_count()):
		if _model_select_btn.get_item_text(i) == saved_model:
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
	_selected_model = _model_select_btn.get_item_text(index)
	var es := EditorInterface.get_editor_settings()
	es.set_setting("ksanadock/model_" + _current_provider, _selected_model)

func _handle_valid_key(key: String, provider: String) -> void:
	if _provider_btn:
		_provider_btn.add_theme_color_override("font_color", Color(0.2, 0.9, 0.2)) # Green
	if _auth:
		_auth.set_api_key(key, provider)
		
		var es := EditorInterface.get_editor_settings()
		es.set_setting("ksanadock/ai_provider", provider)
		
		_add_bubble(MessageBubble.Role.SYSTEM_EVENT, "API key validated and saved.")
		_check_auth_status()
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
	if event is InputEventKey and event.pressed and event.keycode == KEY_ENTER:
		if not event.shift_pressed:
			_send_message()
			get_viewport().set_input_as_handled()


func _send_message() -> void:
	if _is_streaming:
		return
	var text := _input_field.text.strip_edges()
	if text == "" and _context_refs.is_empty():
		return

	# 构建上下文内容
	var full_context = ""
	for ref in _context_refs:
		if ref.type == "file":
			full_context += "[Context File: %s]\n" % ref.data
		elif ref.type == "text":
			full_context += "[Context Reference]:\n%s\n" % ref.data
		elif ref.type == "code":
			var meta = ref.get("meta", {})
			var file = meta.get("file", "unknown")
			var fl = meta.get("from_line", 0)
			var tl = meta.get("to_line", 0)
			full_context += "[Code Reference: %s (lines %d-%d)]\n```gdscript\n%s\n```\n" % [file, fl, tl, ref.data]
	
	if full_context != "":
		text = "--- Context References ---\n" + full_context + "\n--- User Question ---\n" + text

	_input_field.text = ""
	_add_bubble(MessageBubble.Role.USER, text)
	_messages.append({"role": "user", "content": text})
	
	_context_refs.clear()
	_update_ref_list()

	_is_streaming = true
	_send_btn.disabled = true

	if not _bridge and EditorInterface.get_base_control().has_meta("ksanadock_bridge"):
		set_bridge(EditorInterface.get_base_control().get_meta("ksanadock_bridge"))

	if _bridge and _bridge.has_method("send_chat_to_agent"):
		var api_key = _auth.get_api_key(_current_provider) if _auth else ""
		_bridge.send_chat_to_agent(text, _on_bridge_response, false, _current_provider, _selected_model, api_key)
	elif _ai_client:
		_ai_client.send_message(_messages)
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
		var icon = "📄 " if ref.type == "file" else ("💻 " if ref.type == "code" else "📝 ")
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
	var type = result.get("type", "text")
	if type == "plan":
		_add_plan_bubble(result.get("data", {}), result.get("tool_call_id", ""))


func _add_plan_bubble(data: Dictionary, tool_call_id: String) -> void:
	_is_streaming = false
	_send_btn.disabled = false
	if _current_bubble:
		_current_bubble.queue_free()
		_current_bubble = null
	var bubble := PanelContainer.new()
	bubble.set_script(MessageBubble)
	bubble.setup_plan(data.get("title", ""), data.get("steps", []))
	_msg_list.add_child(bubble)
	bubble.plan_approved.connect(_on_plan_approved)
	_scroll_to_bottom()


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
	if _bridge.has_method("get_agent_history"):
		_bridge.get_agent_history(_render_history)


func _on_agent_connected() -> void:
	print("[GodotMaker] Agent connected signal received in Chat UI. Requesting history...")
	if _bridge and _bridge.has_method("get_agent_history"):
		_bridge.get_agent_history(_render_history)


func _render_history(history: Variant) -> void:
	print("[GodotMaker] History callback received. Type: ", typeof(history))
	if history is Array:
		print("[GodotMaker] History size: ", history.size())
	
	if not history is Array or history.is_empty():
		print("[GodotMaker] History is empty or not an array. Returning.")
		return
	for c in _msg_list.get_children():
		c.queue_free()
	_messages.clear()
	for msg in history:
		var role_str = msg.get("role", "")
		var content = msg.get("content", "")
		var role = MessageBubble.Role.AI
		if role_str == "user":
			role = MessageBubble.Role.USER
		elif role_str == "tool":
			role = MessageBubble.Role.TOOL_EXEC
		_add_bubble(role, content)
		_messages.append({"role": role_str, "content": content})
	_scroll_to_bottom()


func _on_agent_event(params: Dictionary) -> void:
	var event_type = params.get("type", "")
	var msg = params.get("message", "")
	var agent_id = params.get("agentId", "")
	if event_type == "process_start":
		_add_bubble(MessageBubble.Role.SYSTEM_EVENT, msg)
		_is_streaming = true
		_send_btn.disabled = true
	elif event_type == "tool_execution":
		_add_bubble(MessageBubble.Role.TOOL_EXEC, msg)
	elif event_type == "error":
		_on_stream_error(msg)
	elif event_type == "process_end":
		_is_streaming = false
		_send_btn.disabled = false
		_add_bubble(MessageBubble.Role.SYSTEM_EVENT, msg)
	elif event_type == "subagent_start":
		var bubble = PanelContainer.new()
		bubble.set_script(MessageBubble)
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


func _on_agent_reply(params: Dictionary) -> void:
	var text = params.get("text", "")
	if text != "":
		_current_bubble = _create_bubble(MessageBubble.Role.AI, "")
		_msg_list.add_child(_current_bubble)
		_on_stream_done(text)


func _on_stream_chunk(text: String) -> void:
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
	_add_bubble(MessageBubble.Role.AI, "[img=16]res://addons/godot_maker/icons/ui/triangle-alert.svg[/img] Error: %s" % message)
	_current_bubble = null


func _add_bubble(role: int, text: String) -> void:
	var bubble := _create_bubble(role, text)
	if _msg_list:
		_msg_list.add_child(bubble)
	_scroll_to_bottom()


func _create_bubble(role: int, text: String) -> PanelContainer:
	var bubble := PanelContainer.new()
	bubble.set_script(MessageBubble)
	bubble.setup(role, text)
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


func _attach_scene_context() -> void:
	var scene_root := EditorInterface.get_edited_scene_root()
	if not scene_root:
		_input_field.text += "\n" + _tr("no_scene")
		return
	var tree_text := _dump_tree(scene_root, 0)
	_input_field.text += "\n--- Scene Tree ---\n" + tree_text


func _dump_tree(node: Node, depth: int) -> String:
	var indent := "  ".repeat(depth)
	var line := "%s%s (%s)\n" % [indent, node.name, node.get_class()]
	for child in node.get_children():
		line += _dump_tree(child, depth + 1)
	return line
