@tool
extends PanelContainer
## 单条聊天消息气泡

enum Role { AI, USER, PLAN, SYSTEM_EVENT, TOOL_EXEC, SUBAGENT }
signal plan_approved(auto_run: bool)

var _role: Role = Role.AI
var _content_label: RichTextLabel
var _subagent_logs_container: VBoxContainer
var _subagent_header_btn: Button

func _ready() -> void:
	# 由父级调用 setup() 初始化，不在 _ready 中构建
	pass


func setup(role: Role, text: String) -> void:
	_role = role
	_build(text)

func setup_plan(title: String, steps: Array) -> void:
	_role = Role.AI
	_build_plan(title, steps)

func setup_subagent(title: String) -> void:
	_role = Role.SUBAGENT
	_build_subagent(title)


func append_text(chunk: String) -> void:
	if _content_label:
		# For streaming, we append raw then re-format the whole thing
		# (Simplified for performance: just append raw if no markdown tags)
		var new_text = _content_label.text + chunk
		_content_label.text = _format_text(new_text)

func set_message(new_text: String) -> void:
	if _content_label:
		_content_label.text = _format_text(new_text)


func get_full_text() -> String:
	if _content_label:
		return _content_label.text
	return ""


func _build(text: String) -> void:
	# 清理旧子节点
	for c in get_children():
		c.queue_free()

	# 根节点设置：透明且占满全宽
	add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	size_flags_horizontal = Control.SIZE_EXPAND_FILL
	
	# 使用 MarginContainer 来处理不同角色的侧边距
	var margin_container := MarginContainer.new()
	margin_container.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	if _role == Role.AI or _role == Role.TOOL_EXEC:
		margin_container.add_theme_constant_override("margin_right", 40)
	elif _role == Role.USER:
		margin_container.add_theme_constant_override("margin_left", 40)
	add_child(margin_container)

	# 创建真正的气泡面板
	var bubble_panel := PanelContainer.new()
	bubble_panel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	margin_container.add_child(bubble_panel)

	# 气泡样式与对齐处理
	var bg: Color
	var border: Color
	if _role == Role.AI:
		bg = KPalette.BUBBLE_AI
		border = KPalette.BUBBLE_AI_BORDER
	elif _role == Role.USER:
		bg = KPalette.BUBBLE_USER
		border = KPalette.BUBBLE_USER_BORDER
	elif _role == Role.TOOL_EXEC:
		bg = Color(0.12, 0.12, 0.15, 0.8)
		border = Color(0.25, 0.25, 0.3, 1.0)
	elif _role == Role.SYSTEM_EVENT:
		bg = Color.TRANSPARENT
		border = Color.TRANSPARENT

	if _role == Role.SYSTEM_EVENT:
		bubble_panel.add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	else:
		if bg and border:
			bubble_panel.add_theme_stylebox_override("panel", KPalette.flat_box(bg, KPalette.RADIUS_MD, border, 1))

	var hbox := HBoxContainer.new()
	hbox.add_theme_constant_override("separation", 8)
	bubble_panel.add_child(hbox)

	# ── 头像标识 ──
	var avatar := Label.new()
	if _role == Role.AI:
		avatar.text = "🤖"
	elif _role == Role.USER:
		avatar.text = "👤"
	elif _role == Role.TOOL_EXEC:
		avatar.text = "⚙️"
	else:
		avatar.text = ""

	if avatar.text != "":
		avatar.add_theme_font_size_override("font_size", 14 if _role == Role.TOOL_EXEC else 16)
		avatar.custom_minimum_size = Vector2(24, 24)
		avatar.vertical_alignment = VERTICAL_ALIGNMENT_TOP

	# ── 内容 ──
	_content_label = RichTextLabel.new()
	_content_label.bbcode_enabled = true
	_content_label.fit_content = true
	_content_label.scroll_active = false
	_content_label.autowrap_mode = TextServer.AUTOWRAP_ARBITRARY
	_content_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	# 关键：设置极小的最小宽度，允许父容器将其压缩，从而强制触发换行逻辑
	_content_label.custom_minimum_size.x = 1
	
	if _role == Role.TOOL_EXEC:
		_content_label.add_theme_color_override("default_color", Color(0.6, 0.6, 0.6))
		_content_label.add_theme_font_size_override("normal_font_size", 12)
		_content_label.text = "[font_size=11][i]" + _format_text(text) + "[/i][/font_size]"
	elif _role == Role.SYSTEM_EVENT:
		_content_label.add_theme_color_override("default_color", Color(0.5, 0.5, 0.5, 0.8))
		_content_label.add_theme_font_size_override("normal_font_size", 11)
		_content_label.text = "[center]" + _format_text(text) + "[/center]"
	else:
		_content_label.add_theme_color_override("default_color", KPalette.TEXT_PRIMARY)
		_content_label.add_theme_font_size_override("normal_font_size", 13)
		_content_label.text = _format_text(text)

	if _role == Role.SYSTEM_EVENT:
		hbox.add_child(_content_label)
	elif _role == Role.AI or _role == Role.TOOL_EXEC:
		hbox.add_child(avatar)
		hbox.add_child(_content_label)
	elif _role == Role.USER:
		hbox.add_child(_content_label)
		hbox.add_child(avatar)

func _build_subagent(title: String) -> void:
	for c in get_children(): c.queue_free()
	
	add_theme_stylebox_override("panel", KPalette.flat_box(Color(0.1, 0.12, 0.18, 0.8), KPalette.RADIUS_MD, Color(0.3, 0.4, 0.6, 0.5), 1))
	size_flags_horizontal = Control.SIZE_EXPAND_FILL
	
	var vbox := VBoxContainer.new()
	add_child(vbox)
	
	var header_hbox := HBoxContainer.new()
	vbox.add_child(header_hbox)
	
	_subagent_header_btn = Button.new()
	_subagent_header_btn.text = "▼ 🤖 [Subagent] " + title
	_subagent_header_btn.alignment = HORIZONTAL_ALIGNMENT_LEFT
	_subagent_header_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_subagent_header_btn.add_theme_stylebox_override("normal", StyleBoxEmpty.new())
	_subagent_header_btn.add_theme_stylebox_override("hover", StyleBoxEmpty.new())
	_subagent_header_btn.add_theme_stylebox_override("pressed", StyleBoxEmpty.new())
	_subagent_header_btn.add_theme_stylebox_override("focus", StyleBoxEmpty.new())
	_subagent_header_btn.add_theme_color_override("font_color", KPalette.TEXT_PRIMARY)
	header_hbox.add_child(_subagent_header_btn)
	
	var margin := MarginContainer.new()
	margin.add_theme_constant_override("margin_left", 24)
	margin.add_theme_constant_override("margin_bottom", 8)
	vbox.add_child(margin)
	
	_subagent_logs_container = VBoxContainer.new()
	_subagent_logs_container.add_theme_constant_override("separation", 4)
	margin.add_child(_subagent_logs_container)
	
	_subagent_header_btn.pressed.connect(func():
		margin.visible = !margin.visible
		_subagent_header_btn.text = ("▼ " if margin.visible else "▶ ") + "🤖 [Subagent] " + title
	)

func append_subagent_log(text: String) -> void:
	if not _subagent_logs_container: return
	var lbl := RichTextLabel.new()
	lbl.bbcode_enabled = true
	lbl.fit_content = true
	lbl.add_theme_font_size_override("normal_font_size", 11)
	lbl.add_theme_color_override("default_color", Color(0.6, 0.65, 0.7))
	lbl.text = "↳ [i]" + _format_text(text) + "[/i]"
	_subagent_logs_container.add_child(lbl)

	# Tween a subtle flash to indicate new log
	var t := create_tween()
	lbl.modulate = Color(1.5, 1.5, 2.0, 1.0)
	t.tween_property(lbl, "modulate", Color.WHITE, 0.5)

func _build_plan(title: String, steps: Array) -> void:
	for c in get_children(): c.queue_free()
	
	add_theme_stylebox_override("panel", KPalette.flat_box(KPalette.BUBBLE_AI, KPalette.RADIUS_MD, KPalette.BUBBLE_AI_BORDER, 1))
	size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	
	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 10)
	add_child(vbox)
	
	var head := Label.new()
	head.text = "📋 工作计划: " + title
	head.add_theme_font_size_override("font_size", 14)
	head.add_theme_color_override("font_color", KPalette.TEXT_PRIMARY)
	vbox.add_child(head)
	
	var list := VBoxContainer.new()
	list.add_theme_constant_override("separation", 4)
	vbox.add_child(list)
	
	for s in steps:
		var step_lbl := RichTextLabel.new()
		step_lbl.bbcode_enabled = true
		step_lbl.fit_content = true
		step_lbl.text = "[color=#94a3b8]%d.[/color] %s" % [s.get("id", 0), s.get("desc", "")]
		step_lbl.add_theme_font_size_override("normal_font_size", 12)
		list.add_child(step_lbl)
		
	var btn_vbox := VBoxContainer.new()
	btn_vbox.add_theme_constant_override("separation", 5)
	vbox.add_child(btn_vbox)
	
	var btn_exec := Button.new()
	btn_exec.text = "▶ 逐步执行"
	btn_exec.custom_minimum_size.y = 30
	btn_exec.add_theme_stylebox_override("normal", KPalette.btn_secondary())
	btn_exec.add_theme_stylebox_override("hover", KPalette.btn_secondary_hover())
	btn_vbox.add_child(btn_exec)
	
	var btn_all := Button.new()
	btn_all.text = "⏩ 全部接受"
	btn_all.custom_minimum_size.y = 32
	btn_all.add_theme_stylebox_override("normal", KPalette.btn_primary())
	btn_all.add_theme_stylebox_override("hover", KPalette.btn_primary_hover())
	btn_vbox.add_child(btn_all)
	
	btn_exec.pressed.connect(func():
		_disable_btns(btn_vbox)
		btn_exec.text = "正在逐步执行..."
		plan_approved.emit(false)
	)
	
	btn_all.pressed.connect(func():
		_disable_btns(btn_vbox)
		btn_all.text = "正在全速执行..."
		plan_approved.emit(true)
	)

func _disable_btns(parent: Control) -> void:
	for c in parent.get_children():
		if c is Button:
			c.disabled = true

func _format_text(raw: String) -> String:
	# 简单 Markdown → BBCode 转换
	var result := raw

	# 1. 块级处理：代码块 ```...``` (优先处理，避免内部干扰)
	var code_regex := RegEx.new()
	code_regex.compile("```(\\w*)\\n?([\\s\\S]*?)```")
	var matches := code_regex.search_all(result)
	for m in matches:
		var lang := m.get_string(1)
		var code := m.get_string(2).strip_edges()
		var header := "[font_size=10][color=#94a3b8]%s[/color][/font_size]\n" % lang if lang != "" else ""
		result = result.replace(m.get_string(), "\n%s[indent][code]%s[/code][/indent]\n" % [header, code])

	# 2. 逐行处理（标题、列表、分割线）
	var lines := result.split("\n")
	for i in range(lines.size()):
		var line = lines[i]
		
		# 标题处理
		if line.begins_with("### "):
			lines[i] = "[font_size=14][b]" + line.trim_prefix("### ") + "[/b][/font_size]"
		elif line.begins_with("## "):
			lines[i] = "\n[font_size=16][b]" + line.trim_prefix("## ") + "[/b][/font_size]"
		elif line.begins_with("# "):
			lines[i] = "\n[font_size=18][b]" + line.trim_prefix("# ") + "[/b][/font_size]"
			
		# 无序列表处理
		elif line.begins_with("- ") or line.begins_with("* "):
			lines[i] = "[indent]• " + line.substr(2) + "[/indent]"
			
		# 分割线
		elif line == "---" or line == "***":
			lines[i] = "[center][color=#334155]────────────────[/color][/center]"
			
	result = "\n".join(lines)

	# 3. 行内处理
	# 行内代码 `...`
	var inline_regex := RegEx.new()
	inline_regex.compile("`([^`]+)`")
	var inline_matches := inline_regex.search_all(result)
	for m in inline_matches:
		result = result.replace(m.get_string(), "[code]%s[/code]" % m.get_string(1))

	# 加粗 **...**
	var bold_regex := RegEx.new()
	bold_regex.compile("\\*\\*(.+?)\\*\\*")
	var bold_matches := bold_regex.search_all(result)
	for m in bold_matches:
		result = result.replace(m.get_string(), "[b]%s[/b]" % m.get_string(1))

	return result.strip_edges()
