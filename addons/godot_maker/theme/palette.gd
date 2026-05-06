@tool
class_name KPalette
extends RefCounted
## GodotMaker 全局调色板 — Cursor/ChatGPT 极简暗黑风 V2
## 核心原则："去容器化" — 消灭不必要的背景色块和边框

# ── 背景 ──
const BG_MAIN := Color("#2a2a2a") # 主背景：极深灰
const BG_CARD := Color("#2a2a2a") # 卡片底色（与主背景融合）
const BG_INPUT := Color("#2a2a2a") # 输入胶囊底色
const BG_HOVER := Color("#333333") # 悬停态底色
const BG_HEADER := Color("#2a2a2a") # 顶栏融入主背景

# ── 强调色 ──
const EMERALD := Color("#10b981")
const EMERALD_DIM := Color("#065f46")
const SKY := Color("#38bdf8")
const SKY_DIM := Color("#0c4a6e")

# ── 文字 ──
const TEXT_PRIMARY := Color("#e8e8e8") # 主文本：柔白
const TEXT_SECONDARY := Color("#a1a1aa")
const TEXT_DIM := Color("#6b6b6b") # 占位符/暗淡
const TEXT_TOOL := Color("#8e8e8e") # 工具日志专用灰
const TEXT_LINK := Color("#34d399")

# ── 边框 ──
const BORDER := Color(1, 1, 1, 0.06)
const BORDER_FOCUS := Color("#10b981", 0.4)
const BORDER_ERROR := Color("#ef4444", 0.5)

# ── 消息气泡 ──
const BUBBLE_USER := Color("#383838") # 用户气泡：深灰色，在 #2a2a2a 背景上可见
const BUBBLE_USER_BORDER := Color.TRANSPARENT # 用户气泡：无边框
const BUBBLE_AI := Color("#2a2a2a") # AI气泡：融入背景
const BUBBLE_AI_BORDER := Color("#2a2a2a") # AI气泡：无边框

# ── 语义色 ──
const SUCCESS := Color("#22c55e")
const WARNING := Color("#f59e0b")
const ERROR := Color("#ef4444")

# ── 圆角 ──
const RADIUS_SM := 8
const RADIUS_MD := 18 # 气泡主圆角（更柔和）
const RADIUS_LG := 24 # 输入胶囊
const RADIUS_PILL := 50 # 全圆（发送按钮）

# ── 间距 ──
const PAD_XS := 4
const PAD_SM := 8
const PAD_MD := 14
const PAD_LG := 18
const PAD_XL := 24

# ── 阴影 ──
const SHADOW_COLOR := Color(0, 0, 0, 0.25)
const SHADOW_SIZE := 6


## 创建纯色圆角 StyleBoxFlat
static func flat_box(bg: Color, radius: int = RADIUS_MD, border_color: Color = Color.TRANSPARENT, border_width: int = 0) -> StyleBoxFlat:
	var sb := StyleBoxFlat.new()
	sb.bg_color = bg
	sb.corner_radius_top_left = radius
	sb.corner_radius_top_right = radius
	sb.corner_radius_bottom_left = radius
	sb.corner_radius_bottom_right = radius
	if border_width > 0:
		sb.border_color = border_color
		sb.border_width_top = border_width
		sb.border_width_bottom = border_width
		sb.border_width_left = border_width
		sb.border_width_right = border_width
	sb.content_margin_top = PAD_MD
	sb.content_margin_bottom = PAD_MD
	sb.content_margin_left = PAD_LG
	sb.content_margin_right = PAD_LG
	return sb


## 创建带阴影的 StyleBoxFlat（用于输入胶囊等悬浮元素）
static func flat_box_shadowed(bg: Color, radius: int = RADIUS_LG, border_color: Color = Color.TRANSPARENT, border_width: int = 0) -> StyleBoxFlat:
	var sb := flat_box(bg, radius, border_color, border_width)
	sb.shadow_color = SHADOW_COLOR
	sb.shadow_size = SHADOW_SIZE
	sb.shadow_offset = Vector2(0, 2)
	return sb


## 创建输入框样式（完全透明无边框，融入胶囊体）
static func input_style_normal() -> StyleBoxFlat:
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color.TRANSPARENT
	sb.content_margin_top = PAD_SM
	sb.content_margin_bottom = PAD_SM
	sb.content_margin_left = 4
	sb.content_margin_right = 4
	return sb


## 输入框焦点样式（保持透明）
static func input_style_focused() -> StyleBoxFlat:
	return input_style_normal()


## 幽灵按钮样式 (Ghost Button) — 透明背景 + 悬停显灰
static func btn_ghost() -> StyleBoxFlat:
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color.TRANSPARENT
	sb.content_margin_top = PAD_XS
	sb.content_margin_bottom = PAD_XS
	sb.content_margin_left = PAD_SM
	sb.content_margin_right = PAD_SM
	return sb


static func btn_ghost_hover() -> StyleBoxFlat:
	var sb := btn_ghost()
	sb.bg_color = Color(1, 1, 1, 0.06)
	sb.corner_radius_top_left = RADIUS_SM
	sb.corner_radius_top_right = RADIUS_SM
	sb.corner_radius_bottom_left = RADIUS_SM
	sb.corner_radius_bottom_right = RADIUS_SM
	return sb


## 发送按钮样式 — 白色正圆
static func btn_send() -> StyleBoxFlat:
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color("#ffffff")
	sb.corner_radius_top_left = RADIUS_PILL
	sb.corner_radius_top_right = RADIUS_PILL
	sb.corner_radius_bottom_left = RADIUS_PILL
	sb.corner_radius_bottom_right = RADIUS_PILL
	sb.content_margin_top = 0
	sb.content_margin_bottom = 0
	sb.content_margin_left = 0
	sb.content_margin_right = 0
	return sb


static func btn_send_hover() -> StyleBoxFlat:
	var sb := btn_send()
	sb.bg_color = Color("#e0e0e0")
	return sb


static func btn_send_pressed() -> StyleBoxFlat:
	var sb := btn_send()
	sb.bg_color = Color("#cccccc")
	return sb


## 创建主按钮样式
static func btn_primary() -> StyleBoxFlat:
	return flat_box(EMERALD, RADIUS_SM)


static func btn_primary_hover() -> StyleBoxFlat:
	return flat_box(EMERALD.lightened(0.15), RADIUS_SM)


static func btn_primary_pressed() -> StyleBoxFlat:
	return flat_box(EMERALD.darkened(0.1), RADIUS_SM)


## 次要按钮（现在也是幽灵风格）
static func btn_secondary() -> StyleBoxFlat:
	return btn_ghost()


static func btn_secondary_hover() -> StyleBoxFlat:
	return btn_ghost_hover()
