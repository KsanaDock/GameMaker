@tool
extends EditorPlugin
## GodotMaker — Godot 插件主入口
##
## 注册 AI Chat Dock 和 Profile Dock，管理用户登录状态。

var _saved_code_selection: String = ""
var _saved_code_context: Dictionary = {}  # {text, file, from_line, to_line}

const ChatScene = preload("res://addons/godot_maker/ui/chat/chat.tscn")
const TerminalScene = preload("res://addons/godot_maker/ui/terminal/terminal.tscn")
const FsContextMenuScript = preload("res://addons/godot_maker/ui/chat/fs_context_menu.gd")

var _chat: VBoxContainer
var _terminal: VBoxContainer
var _auth: KAuthClient
var _fs_context_menu: EditorContextMenuPlugin
var _script_context_menu: EditorContextMenuPlugin


func _enter_tree() -> void:
	_auth = KAuthClient.new()

	# 注册 Chat Dock（右下区域）
	_chat = ChatScene.instantiate()
	add_control_to_dock(DOCK_SLOT_RIGHT_BL, _chat)

	
	# 注册 Chat Dock 信号
	_chat.api_key_saved.connect(_on_api_key_saved)
	
	# 同步 API Key 到环境变量
	if _auth.has_api_key():
		OS.set_environment("KSANADOCK_API_KEY", _auth.get_api_key())

	# 注册 Terminal Dock
	_terminal = TerminalScene.instantiate()
	add_control_to_bottom_panel(_terminal, "Terminal")

	# 注册文件系统和脚本右键菜单（为每个插槽创建独立实例，避免 Godot 重复注册错误）
	_fs_context_menu = FsContextMenuScript.new()
	_fs_context_menu.setup(self)
	add_context_menu_plugin(EditorContextMenuPlugin.CONTEXT_SLOT_FILESYSTEM, _fs_context_menu)
	
	_script_context_menu = FsContextMenuScript.new()
	_script_context_menu.setup(self)
	add_context_menu_plugin(EditorContextMenuPlugin.CONTEXT_SLOT_SCRIPT_EDITOR, _script_context_menu)

	# 钩取 Output 和其他 RichTextLabel 面板的右键菜单
	call_deferred("_hook_richtext_panels")
	
	# 动态监听脚本切换：每次打开或切换脚本时都定向钩取当前代码编辑器
	var se = EditorInterface.get_script_editor()
	if se:
		se.editor_script_changed.connect(_on_script_changed)
		# 对当前已经打开的脚本也立即执行一次
		call_deferred("_hook_current_script_editor")

	
	_initialize_docks()

	print("[GodotMaker] Plugin loaded.")


## 定向钩取：找 ScriptEditorBase(current_editor) 的直属子 PopupMenu
func _hook_current_script_editor() -> void:
	var se = EditorInterface.get_script_editor()
	if not se: return
	var current = se.get_current_editor()
	if not current:
		print("[GodotMaker] DEBUG: get_current_editor() returned null")
		return
	
	var base = current.get_base_editor()
	
	# 在右键点击时，CodeEdit 选区可能已被取消
	# 提前在 gui_input 时抢救选中文本（同时保存文件路径和行号）
	if base and not base.has_meta("_ksanadock_input_hooked"):
		base.set_meta("_ksanadock_input_hooked", true)
		base.gui_input.connect(func(e: InputEvent):
			if e is InputEventMouseButton and e.button_index == MOUSE_BUTTON_RIGHT and e.pressed:
				if base.has_method("get_selected_text"):
					var sel = base.get_selected_text()
					_saved_code_selection = sel
					if not sel.is_empty():
						# 获取当前脚本的文件路径
						var script = EditorInterface.get_script_editor().get_current_script()
						var file_path = script.resource_path if script else ""
						# 获取选区行号（0-indexed → 转为 1-indexed）
						var from_ln = base.get_selection_from_line() + 1
						var to_ln = base.get_selection_to_line() + 1
						_saved_code_context = {
							"text": sel,
							"file": file_path,
							"from_line": from_ln,
							"to_line": to_ln
						}
		)
	
	# 找 current_editor 的直属子 PopupMenu，绑定 base(CodeEdit) 为文本源
	for child in current.get_children():
		if child is PopupMenu and not child.has_meta("_ksanadock_hooked"):
			child.set_meta("_ksanadock_hooked", true)
			print("[GodotMaker] DEBUG: Hooked script editor PopupMenu: ", child.name)
			# 注意：控制传 base(CodeEdit) 而不是 current(ScriptTextEditor)
			child.about_to_popup.connect(_on_editor_popup_about_to_show.bind(base if base else current, child))
	
	# 兜底：同时钩取 CodeEdit.get_menu()
	if base:
		_hook_single_widget(base)


func _hook_single_widget(widget: Control) -> void:
	if widget.has_meta("_ksanadock_hooked"): return
	var pm = widget.get_menu()
	if pm:
		widget.set_meta("_ksanadock_hooked", true)
		pm.about_to_popup.connect(_on_editor_popup_about_to_show.bind(widget, pm))
		print("[GodotMaker] DEBUG: Hooked get_menu() of ", widget.get_class())


func _on_script_changed(_script) -> void:
	# 等待一帧让编辑器 UI 完全切换完毕再进行钩取
	await get_tree().process_frame
	_hook_current_script_editor()


## 扫描 RichTextLabel（用于 Output 面板等）
func _hook_richtext_panels(node: Node = null) -> void:
	if not node:
		node = EditorInterface.get_base_control()
	if node is RichTextLabel:
		var pm = node.get_menu()
		if pm and not node.has_meta("_ksanadock_hooked"):
			node.set_meta("_ksanadock_hooked", true)
			pm.about_to_popup.connect(_on_editor_popup_about_to_show.bind(node, pm))
	for child in node.get_children():
		_hook_richtext_panels(child)


func _on_editor_popup_about_to_show(control: Control, pm: PopupMenu) -> void:
	var selected = ""
	if control and control.has_method("get_selected_text"):
		selected = control.get_selected_text()
	# 若当前选区为空，尝试使用右键点击时预存的选区
	if selected.is_empty() and not _saved_code_selection.is_empty():
		selected = _saved_code_selection
	
	# 首先清空旧的菜单项，避免重复出现
	for i in range(pm.item_count - 1, -1, -1):
		if pm.get_item_id(i) == 1098:
			if i > 0 and pm.is_item_separator(i-1):
				pm.remove_item(i-1)
				pm.remove_item(i-1)
			else:
				pm.remove_item(i)
	
	# 只要有文字（选中或已存），就显示菜单项；CodeEdit 始终显示作为兜底
	if not selected.is_empty() or (control and (control is CodeEdit or control is TextEdit)):
		pm.add_separator()
		pm.add_item("Add to GodotMaker Chat", 1098)
		if not pm.id_pressed.is_connected(_on_editor_id_pressed):
			pm.id_pressed.connect(_on_editor_id_pressed.bind(control))


func _on_editor_id_pressed(id: int, control: Control) -> void:
	if id == 1098:
		if not _chat or not _chat.has_method("add_context_reference"): return
		
		# 优先使用右键前带有文件上下文的保存数据
		if not _saved_code_context.is_empty():
			_chat.add_context_reference("code", _saved_code_context.text, _saved_code_context)
			_saved_code_context = {}
			_saved_code_selection = ""
			return
		
		# 回退：只有文本（无文件信息）
		var text = _saved_code_selection
		_saved_code_selection = ""
		
		if text.is_empty() and control and control.has_method("get_selected_text"):
			text = control.get_selected_text()
		if text.is_empty():
			text = DisplayServer.clipboard_get()
		if not text.is_empty():
			_chat.add_context_reference("text", text)


func get_chat_panel() -> VBoxContainer:
	## 供 FsContextMenu 访问 Chat 面板
	return _chat


func _unhandled_key_input(event: InputEvent) -> void:
	# 快捷键：Ctrl+Shift+C 抓取剪贴板/Output选区到 Chat
	if event is InputEventKey and event.pressed:
		if event.ctrl_pressed and event.shift_pressed and event.keycode == KEY_C:
			if _chat and _chat.has_method("_grab_output_selection"):
				_chat._grab_output_selection()
				print("[GodotMaker] Context grabbed via shortcut.")


func _exit_tree() -> void:
	# 注销文件系统和脚本右键菜单
	if _fs_context_menu:
		remove_context_menu_plugin(_fs_context_menu)
		_fs_context_menu = null
	if _script_context_menu:
		remove_context_menu_plugin(_script_context_menu)
		_script_context_menu = null

	if _chat:
		remove_control_from_docks(_chat)
		_chat.queue_free()
		_chat = null
	if _terminal:
		remove_control_from_bottom_panel(_terminal)
		_terminal.queue_free()
		_terminal = null
	print("[GodotMaker] Plugin unloaded.")



func _on_api_key_saved() -> void:
	pass



func _initialize_docks() -> void:
	if _chat:
		_chat.initialize(_auth)
		if EditorInterface.get_base_control().has_meta("ksanadock_bridge"):
			var bridge = EditorInterface.get_base_control().get_meta("ksanadock_bridge")
			_chat.set_bridge(bridge)
