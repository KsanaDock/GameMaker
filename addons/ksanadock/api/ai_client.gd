@tool
class_name KAIClient
extends RefCounted
## KsanaDock AI 客户端 — 对接 Next.js 后端

signal stream_chunk(text: String)
signal stream_done(full_text: String)
signal stream_error(message: String)

# 本地开环境默认为 localhost:3000
const API_BASE_URL := "http://localhost:3000"

var _auth: KAuthClient


func initialize(auth: KAuthClient) -> void:
	_auth = auth


## 发送对话消息
func send_message(messages: Array[Dictionary], _model: String = "default") -> void:
	if not _auth or (not _auth.is_logged_in() and not _auth.has_api_key()):
		stream_error.emit("Not logged in or no API key.")
		return

	var last_prompt: String = ""
	if not messages.is_empty():
		last_prompt = str(messages[-1].get("content", ""))

	var url: String = API_BASE_URL + "/api/game/chat"
	
	var auth_val = _auth.get_token() if _auth.is_logged_in() else _auth.get_api_key()
	var headers: PackedStringArray = [
		"Authorization: Bearer " + auth_val,
		"Content-Type: application/json"
	]
	var body: String = JSON.stringify({
		"prompt": last_prompt,
		"character_name": "Godot Assistant",
		"mode": "chat"
	})

	var http := HTTPRequest.new()
	EditorInterface.get_base_control().add_child(http)
	http.request_completed.connect(func(r, c, h, b): _on_request_completed(r, c, h, b, http))
	
	var err = http.request(url, headers, HTTPClient.METHOD_POST, body)
	if err != OK:
		stream_error.emit("Failed to start HTTP request (Error %d)" % err)
		http.queue_free()


func _on_request_completed(result: int, code: int, _headers: PackedStringArray, body: PackedByteArray, http: HTTPRequest) -> void:
	http.queue_free()
	
	if result != HTTPRequest.RESULT_SUCCESS:
		stream_error.emit("Network error. Please make sure your local dev server (npm run dev) is running.")
		return

	var json = JSON.parse_string(body.get_string_from_utf8())
	if code != 200:
		if code == 401 and _auth:
			_auth.refresh_session()
			stream_error.emit("Session expired. Please try again in a moment.")
			return
		var err_msg = json.get("error", "AI service returned error %d" % code)
		stream_error.emit(err_msg)
		return

	var full_text = json.get("text", "")
	
	# 由于后端目前不支持 SSE 流，我们在客户端模拟“打字机”流式效果
	_simulate_streaming(full_text)


func _simulate_streaming(text: String) -> void:
	if text == "":
		stream_done.emit("")
		return
		
	var chunks := text.split("")
	var current_text := ""
	for char in chunks:
		# 在编辑器环境下，Engine.get_main_loop() 通常能获取到 SceneTree
		await Engine.get_main_loop().create_timer(0.02).timeout
		stream_chunk.emit(char)
		current_text += char
	
	stream_done.emit(current_text)
