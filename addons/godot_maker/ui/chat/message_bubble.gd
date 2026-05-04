@tool
extends PanelContainer
## 单条聊天消息气泡 — Cursor/ChatGPT 极简暗黑风 V2
## 核心原则：AI 无背景直出文本，User 纯卡片无边框，Tool 内联轻量化

enum Role {AI, USER, PLAN, SYSTEM_EVENT, TOOL_EXEC, SUBAGENT, FILE_DIFF, RESUME_PROMPT}
signal plan_approved(auto_run: bool)
signal file_change_reviewed(file_path: String, accepted: bool)
signal resume_requested()
signal rollback_requested(checkpoint_id: String)

var _role: Role = Role.AI
var _content_label: RichTextLabel
var _subagent_logs_container: VBoxContainer
var _subagent_header_btn: Button
var _tool_detail_container: VBoxContainer
var _tool_collapsed: bool = true
var _checkpoint_id: String = ""

func _ready() -> void:
	# 由父级调用 setup() 初始化，不在 _ready 中构建
	pass


func setup(role: Role, text: String, images: Array = []) -> void:
	_role = role
	_build(text, images)


func set_checkpoint(checkpoint_id: String) -> void:
	_checkpoint_id = checkpoint_id
	if _role == Role.USER and _checkpoint_id != "":
		_add_user_rollback_button()


func setup_plan(title: String, steps: Array) -> void:
	_role = Role.AI
	_build_plan(title, steps)


func setup_subagent(title: String) -> void:
	_role = Role.SUBAGENT
	_build_subagent(title)

func setup_file_diff(file_path: String, content: String) -> void:
	_role = Role.FILE_DIFF
	_build_file_diff(file_path, content)


func setup_resume_prompt(task_count: int) -> void:
	_role = Role.RESUME_PROMPT
	_build_resume_prompt(task_count)


func append_text(chunk: String) -> void:
	if _content_label:
		var new_text = _content_label.text + chunk
		_content_label.text = _format_text(new_text)


func set_message(new_text: String) -> void:
	if _content_label:
		_content_label.text = _format_text(new_text)


func get_full_text() -> String:
	if _content_label:
		return _content_label.text
	return ""


func _build(text: String, images: Array = []) -> void:
	# 清理旧子节点
	for c in get_children():
		c.queue_free()

	# ── 根节点：始终透明外壳 ──
	add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	size_flags_horizontal = Control.SIZE_EXPAND_FILL

	# ── 工具日志和系统事件：极简内联处理，不走气泡路线 ──
	if _role == Role.TOOL_EXEC:
		_build_tool_inline(text)
		return
	if _role == Role.SYSTEM_EVENT:
		_build_system_event(text)
		return

	# ── AI 和 User 消息：走气泡路线 ──
	var margin_container := MarginContainer.new()
	margin_container.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	if _role == Role.AI:
		margin_container.add_theme_constant_override("margin_left", 4)
		margin_container.add_theme_constant_override("margin_right", 40)
	elif _role == Role.USER:
		margin_container.add_theme_constant_override("margin_left", 60)
		margin_container.add_theme_constant_override("margin_right", 4)
	add_child(margin_container)

	var bubble_panel := PanelContainer.new()
	bubble_panel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	margin_container.add_child(bubble_panel)

	match _role:
		Role.USER:
			# 用户气泡：纯色卡片，无边框(border_width = 0)，18px 圆角
			var user_sb := StyleBoxFlat.new()
			user_sb.bg_color = KPalette.BUBBLE_USER
			user_sb.corner_radius_top_left = KPalette.RADIUS_MD
			user_sb.corner_radius_top_right = KPalette.RADIUS_MD
			user_sb.corner_radius_bottom_left = KPalette.RADIUS_MD
			user_sb.corner_radius_bottom_right = KPalette.RADIUS_MD
			user_sb.content_margin_top = 12
			user_sb.content_margin_bottom = 12
			user_sb.content_margin_left = 16
			user_sb.content_margin_right = 16
			bubble_panel.add_theme_stylebox_override("panel", user_sb)
		Role.AI:
			# AI 气泡：完全透明，文本直出（Cursor 风格）
			var ai_empty := StyleBoxEmpty.new()
			ai_empty.content_margin_top = 4
			ai_empty.content_margin_bottom = 4
			ai_empty.content_margin_left = 4
			ai_empty.content_margin_right = 4
			bubble_panel.add_theme_stylebox_override("panel", ai_empty)

	# ── 内容布局 ──
	var hbox := HBoxContainer.new()
	hbox.add_theme_constant_override("separation", 10)
	bubble_panel.add_child(hbox)

	# ── AI 头像：绿色 ✦ ──
	if _role == Role.AI:
		var avatar := Label.new()
		avatar.text = "✦"
		avatar.add_theme_font_size_override("font_size", 16)
		avatar.add_theme_color_override("font_color", KPalette.EMERALD)
		avatar.custom_minimum_size = Vector2(18, 18)
		avatar.vertical_alignment = VERTICAL_ALIGNMENT_TOP
		hbox.add_child(avatar)

	# ── 文本内容 ──
	_content_label = RichTextLabel.new()
	_content_label.bbcode_enabled = true
	_content_label.fit_content = true
	_content_label.scroll_active = false
	_content_label.autowrap_mode = TextServer.AUTOWRAP_ARBITRARY
	_content_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_content_label.custom_minimum_size.x = 1
	_content_label.add_theme_color_override("default_color", KPalette.TEXT_PRIMARY)
	_content_label.add_theme_font_size_override("normal_font_size", 14)
	_content_label.text = _format_text(text)
	hbox.add_child(_content_label)
	if _role == Role.USER and _checkpoint_id != "":
		_add_user_rollback_button()

	# ── 图片附件显示 ──
	if not images.is_empty():
		var img_container := HBoxContainer.new()
		img_container.add_theme_constant_override("separation", 4)
		for img_data in images:
			var tex_rect := TextureRect.new()
			tex_rect.custom_minimum_size = Vector2(120, 90)
			tex_rect.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
			tex_rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
			# img_data is an ImageTexture passed from chat.gd
			if img_data is ImageTexture:
				tex_rect.texture = img_data
			img_container.add_child(tex_rect)
		# Insert images after the content in a VBox wrapper
		var content_vbox := VBoxContainer.new()
		content_vbox.add_theme_constant_override("separation", 6)
		# Re-parent the hbox content into vbox
		bubble_panel.remove_child(hbox)
		content_vbox.add_child(hbox)
		content_vbox.add_child(img_container)
		bubble_panel.add_child(content_vbox)


func _add_user_rollback_button() -> void:
	if _checkpoint_id == "":
		return
	if has_node("UserRollbackMargin"):
		return
	var margin := MarginContainer.new()
	margin.name = "UserRollbackMargin"
	margin.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	margin.add_theme_constant_override("margin_left", 60)
	margin.add_theme_constant_override("margin_right", 4)
	margin.add_theme_constant_override("margin_top", 2)
	add_child(margin)
	
	var row := HBoxContainer.new()
	row.alignment = BoxContainer.ALIGNMENT_END
	margin.add_child(row)
	
	var btn := Button.new()
	btn.text = "Rollback"
	btn.tooltip_text = "Restore project files to before this message"
	btn.custom_minimum_size = Vector2(72, 22)
	btn.add_theme_font_size_override("font_size", 10)
	btn.add_theme_color_override("font_color", KPalette.TEXT_DIM)
	btn.add_theme_color_override("font_hover_color", KPalette.TEXT_PRIMARY)
	btn.add_theme_stylebox_override("normal", KPalette.btn_ghost())
	btn.add_theme_stylebox_override("hover", KPalette.btn_ghost_hover())
	btn.add_theme_stylebox_override("pressed", KPalette.btn_ghost())
	btn.add_theme_stylebox_override("focus", StyleBoxEmpty.new())
	btn.pressed.connect(func(): rollback_requested.emit(_checkpoint_id))
	row.add_child(btn)


## 构建工具执行日志 — 极简内联行（无Panel/无背景/无边框）
## 效果：⚙ Running read_file...    ▶
func _build_tool_inline(text: String) -> void:
	var margin := MarginContainer.new()
	margin.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	margin.add_theme_constant_override("margin_left", 32)
	margin.add_theme_constant_override("margin_right", 60)
	margin.add_theme_constant_override("margin_top", 2)
	margin.add_theme_constant_override("margin_bottom", 2)
	add_child(margin)

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 0)
	margin.add_child(vbox)

	# ── 第一行：图标 + 摘要文本 + 折叠箭头 ──
	var header_hbox := HBoxContainer.new()
	header_hbox.add_theme_constant_override("separation", 8)
	vbox.add_child(header_hbox)

	# 齿轮图标
	var icon_lbl := Label.new()
	icon_lbl.text = "⚙"
	icon_lbl.add_theme_font_size_override("font_size", 12)
	icon_lbl.add_theme_color_override("font_color", KPalette.TEXT_TOOL)
	header_hbox.add_child(icon_lbl)

	# 摘要文本（截取前 80 字符）
	var summary := text.strip_edges()
	if summary.length() > 80:
		summary = summary.left(80) + "…"

	_content_label = RichTextLabel.new()
	_content_label.bbcode_enabled = true
	_content_label.fit_content = true
	_content_label.scroll_active = false
	_content_label.autowrap_mode = TextServer.AUTOWRAP_ARBITRARY
	_content_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_content_label.custom_minimum_size.x = 1
	_content_label.add_theme_color_override("default_color", KPalette.TEXT_TOOL)
	_content_label.add_theme_font_size_override("normal_font_size", 12)
	_content_label.text = summary
	header_hbox.add_child(_content_label)

	# 折叠/展开箭头按钮
	var toggle_btn := Button.new()
	toggle_btn.text = "▶"
	toggle_btn.add_theme_font_size_override("font_size", 10)
	toggle_btn.add_theme_color_override("font_color", KPalette.TEXT_TOOL)
	toggle_btn.add_theme_color_override("font_hover_color", KPalette.TEXT_PRIMARY)
	var empty_sb := StyleBoxEmpty.new()
	toggle_btn.add_theme_stylebox_override("normal", empty_sb)
	toggle_btn.add_theme_stylebox_override("hover", empty_sb)
	toggle_btn.add_theme_stylebox_override("pressed", empty_sb)
	toggle_btn.add_theme_stylebox_override("focus", empty_sb)
	toggle_btn.custom_minimum_size = Vector2(18, 18)
	header_hbox.add_child(toggle_btn)

	# ── 可折叠的详情区域（默认隐藏） ──
	_tool_detail_container = VBoxContainer.new()
	_tool_detail_container.visible = false
	_tool_detail_container.add_theme_constant_override("separation", 2)
	vbox.add_child(_tool_detail_container)

	var detail_margin := MarginContainer.new()
	detail_margin.add_theme_constant_override("margin_left", 20)
	detail_margin.add_theme_constant_override("margin_top", 4)
	_tool_detail_container.add_child(detail_margin)

	var detail_label := RichTextLabel.new()
	detail_label.bbcode_enabled = true
	detail_label.fit_content = true
	detail_label.scroll_active = false
	detail_label.autowrap_mode = TextServer.AUTOWRAP_ARBITRARY
	detail_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	detail_label.custom_minimum_size.x = 1
	detail_label.add_theme_color_override("default_color", Color("#777777"))
	detail_label.add_theme_font_size_override("normal_font_size", 11)
	var detail_text = text.strip_edges()
	if detail_text.length() > 1500:
		detail_text = detail_text.left(1500) + "\n... (Content truncated due to UI limits)"

	detail_label.text = "[i]" + _format_text(detail_text) + "[/i]"
	detail_margin.add_child(detail_label)

	# 折叠切换逻辑
	toggle_btn.pressed.connect(func():
		_tool_collapsed = !_tool_collapsed
		_tool_detail_container.visible = !_tool_collapsed
		toggle_btn.text = "▼" if !_tool_collapsed else "▶"
	)


## 构建系统事件 — 极简居中文本
func _build_system_event(text: String) -> void:
	var margin := MarginContainer.new()
	margin.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	margin.add_theme_constant_override("margin_top", 4)
	margin.add_theme_constant_override("margin_bottom", 4)
	add_child(margin)

	_content_label = RichTextLabel.new()
	_content_label.bbcode_enabled = true
	_content_label.fit_content = true
	_content_label.scroll_active = false
	_content_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_content_label.add_theme_color_override("default_color", Color(0.4, 0.4, 0.4, 0.6))
	_content_label.add_theme_font_size_override("normal_font_size", 11)
	_content_label.text = "[center]" + _format_text(text) + "[/center]"
	margin.add_child(_content_label)


func _build_subagent(title: String) -> void:
	for c in get_children(): c.queue_free()

	# Subagent：极简风格，无厚重面板
	var sb := StyleBoxEmpty.new()
	sb.content_margin_left = 32
	sb.content_margin_right = 16
	sb.content_margin_top = 4
	sb.content_margin_bottom = 4
	add_theme_stylebox_override("panel", sb)
	size_flags_horizontal = Control.SIZE_EXPAND_FILL

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 2)
	add_child(vbox)

	var header_hbox := HBoxContainer.new()
	header_hbox.add_theme_constant_override("separation", 6)
	vbox.add_child(header_hbox)

	# 图标
	var icon := Label.new()
	icon.text = "🧠"
	icon.add_theme_font_size_override("font_size", 12)
	icon.add_theme_color_override("font_color", KPalette.TEXT_TOOL)
	header_hbox.add_child(icon)

	_subagent_header_btn = Button.new()
	_subagent_header_btn.text = "▼ " + title
	_subagent_header_btn.alignment = HORIZONTAL_ALIGNMENT_LEFT
	_subagent_header_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_subagent_header_btn.add_theme_font_size_override("font_size", 12)
	_subagent_header_btn.add_theme_color_override("font_color", KPalette.TEXT_TOOL)
	_subagent_header_btn.add_theme_color_override("font_hover_color", KPalette.TEXT_PRIMARY)
	var empty := StyleBoxEmpty.new()
	_subagent_header_btn.add_theme_stylebox_override("normal", empty)
	_subagent_header_btn.add_theme_stylebox_override("hover", empty)
	_subagent_header_btn.add_theme_stylebox_override("pressed", empty)
	_subagent_header_btn.add_theme_stylebox_override("focus", empty)
	header_hbox.add_child(_subagent_header_btn)

	var logs_margin := MarginContainer.new()
	logs_margin.add_theme_constant_override("margin_left", 20)
	logs_margin.add_theme_constant_override("margin_bottom", 4)
	vbox.add_child(logs_margin)

	_subagent_logs_container = VBoxContainer.new()
	_subagent_logs_container.add_theme_constant_override("separation", 2)
	logs_margin.add_child(_subagent_logs_container)

	_subagent_header_btn.pressed.connect(func():
		logs_margin.visible = !logs_margin.visible
		_subagent_header_btn.text = ("▼ " if logs_margin.visible else "▶ ") + title
	)


func append_subagent_log(text: String) -> void:
	if not _subagent_logs_container: return
	var lbl := RichTextLabel.new()
	lbl.bbcode_enabled = true
	lbl.fit_content = true
	lbl.add_theme_font_size_override("normal_font_size", 11)
	lbl.add_theme_color_override("default_color", Color("#777777"))
	lbl.text = "↳ [i]" + _format_text(text) + "[/i]"
	_subagent_logs_container.add_child(lbl)

	var t := create_tween()
	lbl.modulate = Color(1.2, 1.2, 1.3, 1.0)
	t.tween_property(lbl, "modulate", Color.WHITE, 0.3)


func _build_plan(title: String, steps: Array) -> void:
	for c in get_children(): c.queue_free()

	# Plan 面板保留轻量卡片风格
	var plan_sb := StyleBoxFlat.new()
	plan_sb.bg_color = Color("#242424")
	plan_sb.corner_radius_top_left = KPalette.RADIUS_MD
	plan_sb.corner_radius_top_right = KPalette.RADIUS_MD
	plan_sb.corner_radius_bottom_left = KPalette.RADIUS_MD
	plan_sb.corner_radius_bottom_right = KPalette.RADIUS_MD
	plan_sb.content_margin_top = 16
	plan_sb.content_margin_bottom = 16
	plan_sb.content_margin_left = 18
	plan_sb.content_margin_right = 18
	add_theme_stylebox_override("panel", plan_sb)
	size_flags_horizontal = Control.SIZE_SHRINK_BEGIN

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 12)
	add_child(vbox)

	var head := Label.new()
	head.text = "📋 工作计划: " + title
	head.add_theme_font_size_override("font_size", 14)
	head.add_theme_color_override("font_color", KPalette.TEXT_PRIMARY)
	vbox.add_child(head)

	var list := VBoxContainer.new()
	list.add_theme_constant_override("separation", 6)
	vbox.add_child(list)

	for s in steps:
		var step_lbl := RichTextLabel.new()
		step_lbl.bbcode_enabled = true
		step_lbl.fit_content = true
		step_lbl.text = "[color=#94a3b8]%d.[/color] %s" % [s.get("id", 0), s.get("desc", "")]
		step_lbl.add_theme_font_size_override("normal_font_size", 13)
		list.add_child(step_lbl)

	var btn_vbox := VBoxContainer.new()
	btn_vbox.add_theme_constant_override("separation", 6)
	vbox.add_child(btn_vbox)

	var btn_exec := Button.new()
	btn_exec.text = "▶ 逐步执行"
	btn_exec.custom_minimum_size.y = 32
	btn_exec.add_theme_stylebox_override("normal", KPalette.btn_secondary())
	btn_exec.add_theme_stylebox_override("hover", KPalette.btn_secondary_hover())
	btn_vbox.add_child(btn_exec)

	var btn_all := Button.new()
	btn_all.text = "⏩ 全部接受"
	btn_all.custom_minimum_size.y = 34
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


func _build_file_diff(file_path: String, content: String) -> void:
	for c in get_children(): c.queue_free()

	# Diff 面板样式
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color("#1a1a1a")
	sb.border_color = Color("#333333")
	sb.border_width_left = 4 # 左侧边带强调
	sb.corner_radius_top_right = KPalette.RADIUS_SM
	sb.corner_radius_bottom_right = KPalette.RADIUS_SM
	sb.content_margin_top = 12
	sb.content_margin_bottom = 12
	sb.content_margin_left = 16
	sb.content_margin_right = 16
	add_theme_stylebox_override("panel", sb)
	size_flags_horizontal = Control.SIZE_EXPAND_FILL

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 10)
	add_child(vbox)

	# 标题：图标 + 文件路径
	var head := HBoxContainer.new()
	head.add_theme_constant_override("separation", 8)
	vbox.add_child(head)

	var icon := Label.new()
	icon.text = "📝"
	head.add_child(icon)

	var path_lbl := Label.new()
	path_lbl.text = file_path.get_file()
	path_lbl.tooltip_text = file_path
	path_lbl.add_theme_font_size_override("font_size", 13)
	path_lbl.add_theme_color_override("font_color", KPalette.TEXT_PRIMARY)
	head.add_child(path_lbl)

	var hint := Label.new()
	hint.text = "(建议的改动)"
	hint.add_theme_font_size_override("font_size", 11)
	hint.add_theme_color_override("font_color", KPalette.TEXT_DIM)
	head.add_child(hint)

	# 代码展示区
	var code_bg := PanelContainer.new()
	var code_sb := StyleBoxFlat.new()
	code_sb.bg_color = Color("#0d0d0d")
	code_sb.corner_radius_top_left = 4
	code_sb.corner_radius_top_right = 4
	code_sb.corner_radius_bottom_left = 4
	code_sb.corner_radius_bottom_right = 4
	code_sb.content_margin_all = 8
	code_bg.add_theme_stylebox_override("panel", code_sb)
	vbox.add_child(code_bg)

	_content_label = RichTextLabel.new()
	_content_label.bbcode_enabled = true
	_content_label.fit_content = true
	_content_label.scroll_active = false
	_content_label.add_theme_font_size_override("normal_font_size", 12)
	_content_label.text = "[code]" + _format_text(content) + "[/code]"
	code_bg.add_child(_content_label)

	# 按钮区
	var btn_hbox := HBoxContainer.new()
	btn_hbox.add_theme_constant_override("separation", 12)
	vbox.add_child(btn_hbox)

	var btn_reject := Button.new()
	btn_reject.text = "✕ 拒绝"
	btn_reject.add_theme_stylebox_override("normal", KPalette.btn_ghost())
	btn_reject.add_theme_stylebox_override("hover", KPalette.btn_ghost_hover())
	btn_hbox.add_child(btn_reject)

	var btn_accept := Button.new()
	btn_accept.text = "✓ 接受并应用"
	btn_accept.add_theme_stylebox_override("normal", KPalette.flat_box(KPalette.EMERALD_DIM, 8))
	btn_accept.add_theme_stylebox_override("hover", KPalette.flat_box(KPalette.EMERALD, 8))
	btn_hbox.add_child(btn_accept)

	btn_accept.pressed.connect(func():
		_disable_btns(btn_hbox)
		btn_accept.text = "已应用"
		file_change_reviewed.emit(file_path, true)
	)

	btn_reject.pressed.connect(func():
		_disable_btns(btn_hbox)
		btn_reject.text = "已拒绝"
		file_change_reviewed.emit(file_path, false)
	)


func _build_resume_prompt(task_count: int) -> void:
	for c in get_children(): c.queue_free()

	# 恢复提示气泡样式：深紫调暗色，表示提醒
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color("#1e1e2e") 
	sb.border_color = KPalette.EMERALD
	sb.border_width_left = 4
	sb.corner_radius_top_right = KPalette.RADIUS_MD
	sb.corner_radius_bottom_right = KPalette.RADIUS_MD
	sb.content_margin_top = 16
	sb.content_margin_bottom = 16
	sb.content_margin_left = 18
	sb.content_margin_right = 18
	add_theme_stylebox_override("panel", sb)
	size_flags_horizontal = Control.SIZE_EXPAND_FILL

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 10)
	add_child(vbox)

	# 标题区
	var head := HBoxContainer.new()
	head.add_theme_constant_override("separation", 8)
	vbox.add_child(head)

	var icon := Label.new()
	icon.text = "🕒"
	head.add_child(icon)

	var title := Label.new()
	title.text = "发现未完成的任务"
	title.add_theme_font_size_override("font_size", 14)
	title.add_theme_color_override("font_color", KPalette.TEXT_PRIMARY)
	head.add_child(title)

	# 描述区
	var desc := RichTextLabel.new()
	desc.bbcode_enabled = true
	desc.fit_content = true
	desc.scroll_active = false
	desc.autowrap_mode = TextServer.AUTOWRAP_ARBITRARY
	desc.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	desc.add_theme_font_size_override("normal_font_size", 13)
	desc.add_theme_color_override("default_color", KPalette.TEXT_DIM)
	
	var msg = "您上次退出时还有一些任务正在进行中。"
	if task_count > 0:
		msg += "\n当前有 [b]%d[/b] 个任务处于待办或进行中状态。" % task_count
	msg += "\n是否现在继续执行？"
	
	desc.text = msg
	vbox.add_child(desc)

	# 按钮区
	var btn_hbox := HBoxContainer.new()
	btn_hbox.add_theme_constant_override("separation", 12)
	vbox.add_child(btn_hbox)

	var btn_ignore := Button.new()
	btn_ignore.text = "暂时忽略"
	btn_ignore.add_theme_stylebox_override("normal", KPalette.btn_ghost())
	btn_ignore.add_theme_stylebox_override("hover", KPalette.btn_ghost_hover())
	btn_hbox.add_child(btn_ignore)

	var btn_resume := Button.new()
	btn_resume.text = "继续执行任务"
	btn_resume.add_theme_stylebox_override("normal", KPalette.btn_primary())
	btn_resume.add_theme_stylebox_override("hover", KPalette.btn_primary_hover())
	btn_hbox.add_child(btn_resume)

	btn_resume.pressed.connect(func():
		_disable_btns(btn_hbox)
		btn_resume.text = "正在恢复..."
		resume_requested.emit()
	)
	
	btn_ignore.pressed.connect(func():
		_disable_btns(btn_hbox)
		queue_free()
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
		# Use bgcolor and color to simulate code block without disabling word-wrap
		result = result.replace(m.get_string(), "\n%s[indent][color=#a3be8c]%s[/color][/indent]\n" % [header, code])

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
		# Use bgcolor and color to simulate inline code without disabling word-wrap
		result = result.replace(m.get_string(), "[bgcolor=#1a1a1a][color=#38bdf8] %s [/color][/bgcolor]" % m.get_string(1))

	# 加粗 **...**
	var bold_regex := RegEx.new()
	bold_regex.compile("\\*\\*(.+?)\\*\\*")
	var bold_matches := bold_regex.search_all(result)
	for m in bold_matches:
		result = result.replace(m.get_string(), "[b]%s[/b]" % m.get_string(1))

	return result.strip_edges()
