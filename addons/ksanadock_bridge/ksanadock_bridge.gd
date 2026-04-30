@tool
extends EditorPlugin

## KsanaDock Bridge — Godot 4.x 编辑器插件
##
## 作为 WebSocket Server 监听 9080 端口。
## 接收来自 Agent Service 的 JSON-RPC 指令并执行。

signal agent_event(params: Dictionary)
signal agent_reply(params: Dictionary)

const PORT = 9080

var _server: TCPServer
var _clients: Array[WebSocketPeer] = []
var _pending_requests: Dictionary = {} # id -> callback
var _agent_pid: int = -1
var _log_path: String = ""
var _last_log_size: int = 0

const DEBUG_MODE = true # 设置为 true 可以在 Godot 输出面板查看 Agent 服务的启动过程

func _enter_tree() -> void:
    # 1. 注册项目设置
    _register_settings()
    
    # 2. 尝试自动启动 Agent Service
    _start_agent_service()
    
    # 3. 启动 WebSocket Server
    _server = TCPServer.new()
    var err = _server.listen(PORT)
    if err != OK:
        printerr("[KsanaDock Bridge] Failed to listen on port ", PORT)
    else:
        print("[KsanaDock Bridge] Listening on port ", PORT)
        # 启动定时轮询
        set_process(true)
    
    # Register this plugin instance globally in the editor for other plugins to find
    EditorInterface.get_base_control().set_meta("ksanadock_bridge", self)

func _exit_tree() -> void:
    # 1. 停止 Agent Service
    _stop_agent_service()
    
    # 2. 清理元数据与连接
    if EditorInterface.get_base_control().has_meta("ksanadock_bridge"):
        EditorInterface.get_base_control().remove_meta("ksanadock_bridge")
    
    if _server:
        _server.stop()
    for client in _clients:
        client.close()
    print("[KsanaDock Bridge] Stopped.")

func _process(_delta: float) -> void:
    # 轮询日志
    _poll_logs()

    # 检查新连接
    if _server and _server.is_connection_available():
        var peer = _server.take_connection()
        var ws_peer = WebSocketPeer.new()
        ws_peer.accept_stream(peer)
        _clients.append(ws_peer)
        print("[KsanaDock Bridge] New agent connected.")

    # 处理现有连接
    var to_remove = []
    for i in range(_clients.size()):
        var client = _clients[i]
        client.poll()
        
        var state = client.get_ready_state()
        if state == WebSocketPeer.STATE_OPEN:
            while client.get_available_packet_count() > 0:
                var packet = client.get_packet()
                var json_str = packet.get_string_from_utf8()
                _handle_message(client, json_str)
        elif state == WebSocketPeer.STATE_CLOSED:
            to_remove.append(i)
    
    # 移除断开的连接
    for i in to_remove:
        _clients.remove_at(i)

func _handle_message(client: WebSocketPeer, message: String) -> void:
    if DEBUG_MODE:
        print("[KsanaDock Bridge] RAW RECEIVE: ", message)
        
    var json = JSON.new()
    var err = json.parse(message)
    if err != OK:
        _send_error(client, null, -32700, "Parse error")
        return
        
    var data = json.get_data()
    if typeof(data) != TYPE_DICTIONARY:
        _send_error(client, null, -32600, "Invalid Request")
        return

    var id = data.get("id")
    var method = data.get("method")
    var params = data.get("params", {})

    # Determine if it's a response (contains result or error, no method)
    if not method and id != null:
        if data.has("result"):
            _handle_rpc_result(str(id), data.get("result"))
            return
        elif data.has("error"):
            _handle_rpc_error(str(id), data.get("error"))
            return

    # It's a request/notification
    if method == null:
        _send_error(client, id, -32600, "Invalid Request: missing method")
        return

    # Handle Agent Service unilateral notifications
    if method == "agent_event":
        agent_event.emit(params)
        return
    elif method == "agent_reply":
        agent_reply.emit(params)
        return

    print("[KsanaDock Bridge] Received method: ", method)

    match method:
        "ping":
            _send_result(client, id, "pong")
        "create_node":
            _handle_create_node(client, id, params)
        "delete_node":
            _handle_delete_node(client, id, params)
        "get_scene_tree":
            _handle_get_scene_tree(client, id, params)
        "chat":
            _handle_chat_proxy(client, id, params)
        "set_property":
            _handle_set_property(client, id, params)
        "save_scene":
            _handle_save_scene(client, id, params)
        "create_new_scene":
            _handle_create_new_scene(client, id, params)
        "instantiate_scene":
            _handle_instantiate_scene(client, id, params)
        "search_assets":
            _handle_search_assets(client, id, params)
        _:
            _send_error(client, id, -32601, "Method not found: " + str(method))

func _handle_chat_proxy(_client: WebSocketPeer, _id, _params: Dictionary) -> void:
    # If this came from an internal Godot call (the UI), forward it to the first Agent
    # For now, let's assume the UI calls this method.
    # We need to distinguish between Agent->Godot and UI->Godot.
    # Usually UI will call a helper function on this script instead of sending a JSON packet to itself.
    pass

## UI API
func send_chat_to_agent(message: String, callback: Callable, auto_run: bool = false) -> void:
    if _clients.is_empty():
        callback.call({"error": "No agent connected"})
        return
    
    var req_id = str(Time.get_ticks_msec())
    _pending_requests[req_id] = callback
    
    var active_scene = ""
    var root = EditorInterface.get_edited_scene_root()
    if root:
        active_scene = root.scene_file_path
        
    var request = {
        "jsonrpc": "2.0",
        "method": "chat",
        "params": {
            "message": message,
            "autoRun": auto_run,
            "active_scene": active_scene
        },
        "id": req_id
    }
    _clients[0].send_text(JSON.stringify(request))

func get_agent_history(callback: Callable) -> void:
    if _clients.is_empty():
        return
    
    var req_id = "hist_" + str(Time.get_ticks_msec())
    _pending_requests[req_id] = callback
    
    var active_scene = ""
    var root = EditorInterface.get_edited_scene_root()
    if root:
        active_scene = root.scene_file_path

    var request = {
        "jsonrpc": "2.0",
        "method": "get_history",
        "params": {
            "active_scene": active_scene
        },
        "id": req_id
    }
    _clients[0].send_text(JSON.stringify(request))

func restart_service() -> void:
    print("[KsanaDock Bridge] Restarting Agent service...")
    _stop_agent_service()
    # Wait a bit for the port to be released
    await get_tree().create_timer(1.0).timeout
    _start_agent_service()

func _register_settings() -> void:
    var setting_path = "ksanadock/agent/service_path"
    if not ProjectSettings.has_setting(setting_path):
        ProjectSettings.set_setting(setting_path, "")
    
    var info = {
        "name": setting_path,
        "type": TYPE_STRING,
        "hint": PROPERTY_HINT_DIR,
        "hint_string": "Path to the ksanadock-agent-service directory"
    }
    ProjectSettings.add_property_info(info)
    ProjectSettings.set_initial_value(setting_path, "")

func _start_agent_service() -> void:
    var project_dir = ProjectSettings.globalize_path("res://")
    var agent_dir = ""

    # 路径探测优先级:
    # 1. 插件内部 bundled 目录 (addons/ksanadock_bridge/service) - 零配置分发的首选
    var bundle_path = project_dir.path_join("addons/ksanadock_bridge/service")
    if DirAccess.dir_exists_absolute(bundle_path):
        agent_dir = bundle_path
    
    # 2. ProjectSettings 手动设置 - 用户自定义路径
    if agent_dir == "" or not DirAccess.dir_exists_absolute(agent_dir):
        var setting_path = ProjectSettings.get_setting("ksanadock/agent/service_path")
        if setting_path != "" and setting_path != null:
            agent_dir = ProjectSettings.globalize_path(setting_path)
            
    # 3. 开发环境默认目录 (res://../../ksanadock-agent-service)
    if agent_dir == "" or not DirAccess.dir_exists_absolute(agent_dir):
        var dev_path = project_dir.path_join("../../ksanadock-agent-service")
        if DirAccess.dir_exists_absolute(dev_path):
            agent_dir = dev_path

    if agent_dir == "" or not DirAccess.dir_exists_absolute(agent_dir):
        printerr("[KsanaDock Bridge] Agent service directory not found. Please set 'ksanadock/agent/service_path' in Project Settings.")
        return

    print("[KsanaDock Bridge] Using agent service at: ", agent_dir)

    # 准备日志文件以便轮询 (移动到 user:// 目录以避开 Godot 的资源扫描器)
    _log_path = ProjectSettings.globalize_path("user://ksanadock_agent.log")
    _last_log_size = 0

    # 在 Windows 上通过 cmd 启动，确保切换到正确的运行目录
    # 执行命令: cmd /c "cd /d {agent_dir} && npx tsx src/index.ts --project-root {project_dir}"
    var cmd_str = "cd /d \"" + agent_dir + "\" && npx tsx src/index.ts --project-root \"" + project_dir + "\""
    if DEBUG_MODE:
        cmd_str += " > \"" + _log_path + "\" 2>&1"
        print("[KsanaDock Bridge] Starting service with command: ", cmd_str)
    
    var args = ["/c", cmd_str]
    _agent_pid = OS.create_process("cmd.exe", args, false)
    
    if _agent_pid != -1:
        print("[KsanaDock Bridge] Agent service started with PID: ", _agent_pid)
    else:
        printerr("[KsanaDock Bridge] Failed to start Agent service.")

func _poll_logs() -> void:
    if _log_path == "" or not DEBUG_MODE:
        return
    
    if not FileAccess.file_exists(_log_path):
        return
        
    var f = FileAccess.open(_log_path, FileAccess.READ)
    if f:
        var current_size = f.get_length()
        if current_size < _last_log_size:
            # 文件被清空或重载了
            _last_log_size = 0
            
        if current_size > _last_log_size:
            f.seek(_last_log_size)
            while f.get_position() < current_size:
                var line = f.get_line()
                if line != "":
                    print("[Agent Service] ", line)
            _last_log_size = current_size
        f.close()

func _stop_agent_service() -> void:
    if _agent_pid != -1:
        print("[KsanaDock Bridge] Stopping Agent service (PID: ", _agent_pid, ")")
        OS.kill(_agent_pid)
        _agent_pid = -1

func _handle_rpc_result(id: Variant, result: Variant) -> void:
    var id_str = str(id)
    if DEBUG_MODE:
        print("[KsanaDock Bridge] Handling result for ID: ", id_str, ", Results: ", result)
        
    if _pending_requests.has(id_str):
        var cb = _pending_requests[id_str]
        cb.call(result)
        _pending_requests.erase(id_str)
    else:
        printerr("[KsanaDock Bridge] Warning: Received result for unknown ID: ", id_str, ". Pending: ", _pending_requests.keys())

func _handle_rpc_error(id: Variant, error: Variant) -> void:
    var id_str = str(id)
    printerr("[KsanaDock Bridge] RPC error for ID: ", id_str, ": ", error)
    if _pending_requests.has(id_str):
        var cb = _pending_requests[id_str]
        cb.call({"error": error})
        _pending_requests.erase(id_str)

func _handle_create_node(client: WebSocketPeer, id, params: Dictionary) -> void:
    var type = params.get("type", "Node2D")
    var node_name = params.get("name", "NewNode")
    
    # 检查节点类型是否存在
    if not ClassDB.class_exists(type):
        _send_error(client, id, -32602, "Invalid node type: " + type)
        return

    var node = ClassDB.instantiate(type)
    node.name = node_name
    
    var edited_scene = EditorInterface.get_edited_scene_root()
    if not edited_scene:
        _send_error(client, id, -1, "No active scene to add node to.")
        return
        
    edited_scene.add_child(node)
    node.owner = edited_scene # 必须设置 owner 才能在场景中保存
    
    # 自动扫描并刷新编辑器以同步新节点
    EditorInterface.get_resource_filesystem().scan()
    
    # 处理属性
    var props = params.get("properties", {})
    for p_name in props:
        var val = props[p_name]
        if p_name == "position" and val is Array and val.size() == 2:
            node.set(p_name, Vector2(val[0], val[1]))
        elif p_name == "position" and val is Array and val.size() == 3:
            node.set(p_name, Vector3(val[0], val[1], val[2]))
        elif val is String and ClassDB.class_exists(val):
            # 自动实例化资源 (如 BoxMesh, BoxShape3D)
            var res = ClassDB.instantiate(val)
            if res is Resource:
                node.set(p_name, res)
            else:
                node.set(p_name, val) # 回退到普通字符串
        else:
            node.set(p_name, val)
            
    _send_result(client, id, {"name": node.name, "path": str(node.get_path())})

func _handle_delete_node(client: WebSocketPeer, id, params: Dictionary) -> void:
    var path = params.get("path")
    var node = EditorInterface.get_edited_scene_root().get_node_or_null(path)
    if not node:
        _send_error(client, id, -32602, "Node not found at path: " + str(path))
        return
    node.queue_free()
    _send_result(client, id, "ok")

func _handle_get_scene_tree(client: WebSocketPeer, id, _params: Dictionary) -> void:
    var root = EditorInterface.get_edited_scene_root()
    if not root:
        _send_result(client, id, "No active scene")
        return
    var dump = _dump_tree(root, 0)
    _send_result(client, id, dump)

func _dump_tree(node: Node, depth: int) -> String:
    var indent = "  ".repeat(depth)
    var line = "%s%s (%s) path: %s\n" % [indent, node.name, node.get_class(), node.get_path()]
    for child in node.get_children():
        line += _dump_tree(child, depth + 1)
    return line

func _handle_set_property(client: WebSocketPeer, id, params: Dictionary) -> void:
    var path = params.get("path")
    var prop = params.get("property")
    var val = params.get("value")
    
    var root = EditorInterface.get_edited_scene_root()
    if not root:
        _send_error(client, id, -1, "No active scene")
        return
    
    # Handle aliases
    if prop == "script_source": prop = "script"
    if prop == "gd_script": prop = "script"
        
    # Normalize path (e.g. "World/Player" -> "Player" if root is "World")
    if path != "." and path != "" and path.begins_with(root.name + "/"):
        path = path.trim_prefix(root.name + "/")
    elif path == root.name:
        path = "."
        
    var node = root.get_node_or_null(path)
    if not node:
        _send_error(client, id, -32602, "Node not found at path: " + str(path))
        return
        
    # Handle resource properties
    if (prop == "script" or prop == "texture") and val is String:
        if FileAccess.file_exists(val):
            val = load(val)
        else:
            _send_error(client, id, -32602, "Resource file not found: " + val)
            return

    node.set(prop, val)
    EditorInterface.get_resource_filesystem().scan()
    _send_result(client, id, "ok")

func _handle_search_assets(client: WebSocketPeer, id, params: Dictionary) -> void:
    var filter = params.get("filter", "")
    var limit = params.get("limit", 20)
    var results = []
    
    _collect_assets("res://", filter, results, limit)
    _send_result(client, id, {"assets": results})

func _collect_assets(dir_path: String, filter: String, results: Array, limit: int) -> void:
    if results.size() >= limit:
        return
        
    var dir = DirAccess.open(dir_path)
    if not dir:
        return
        
    dir.list_dir_begin()
    var file_name = dir.get_next()
    while file_name != "":
        if dir.current_is_dir():
            if not file_name.begins_with("."):
                _collect_assets(dir_path.path_join(file_name) + "/", filter, results, limit)
        else:
            var full_path = dir_path.path_join(file_name)
            if filter == "" or file_name.match("*" + filter + "*"):
                results.append(full_path)
                if results.size() >= limit:
                    break
        file_name = dir.get_next()

func _handle_save_scene(client: WebSocketPeer, id, params: Dictionary) -> void:
    var path = params.get("path")
    if not path.begins_with("res://"):
        path = "res://" + path
    
    var root = EditorInterface.get_edited_scene_root()
    if not root:
        _send_error(client, id, -1, "No active scene to save")
        return
        
    var packed := PackedScene.new()
    var err = packed.pack(root)
    if err != OK:
        _send_error(client, id, err, "Failed to pack scene")
        return
        
    _ensure_path_dir(path)
    err = ResourceSaver.save(packed, path)
    if err != OK:
        _send_error(client, id, err, "Failed to save scene to: " + path)
        return
        
    EditorInterface.get_resource_filesystem().scan()
    _send_result(client, id, {"path": path})

func _handle_create_new_scene(client: WebSocketPeer, id, params: Dictionary) -> void:
    var root_type = params.get("root_type", "Node2D")
    var root_name = params.get("root_name", "Main")
    var path = params.get("path", "res://new_scene.tscn")
    
    if not ClassDB.class_exists(root_type):
        _send_error(client, id, -32602, "Invalid root type: " + root_type)
        return
        
    var node = ClassDB.instantiate(root_type)
    node.name = root_name
    
    # Create and save the scene to make it "active"
    var packed := PackedScene.new()
    var err = packed.pack(node)
    if err != OK:
        _send_error(client, id, err, "Failed to pack initial scene")
        return
        
    _ensure_path_dir(path)
    err = ResourceSaver.save(packed, path)
    if err != OK:
        _send_error(client, id, err, "Failed to save new scene to: " + path)
        return
    
    # Refresh and open the scene so it becomes the edited scene
    EditorInterface.get_resource_filesystem().scan()
    EditorInterface.open_scene_from_path(path)
    
    _send_result(client, id, {"root": node.name, "path": path})

func _handle_instantiate_scene(client: WebSocketPeer, id, params: Dictionary) -> void:
    var scene_path = params.get("scene_path")
    var parent_path = params.get("parent_path", ".")
    
    if not FileAccess.file_exists(scene_path):
        _send_error(client, id, -32602, "Scene file not found: " + scene_path)
        return
        
    var scene = load(scene_path)
    if not scene is PackedScene:
        _send_error(client, id, -32602, "File is not a scene: " + scene_path)
        return
        
    var instance = scene.instantiate()
    var root = EditorInterface.get_edited_scene_root()
    var parent = root.get_node(parent_path) if root else null
    
    if not parent:
        _send_error(client, id, -1, "Parent node not found")
        return
        
    parent.add_child(instance)
    instance.owner = root
    _send_result(client, id, {"path": str(instance.get_path())})

func _ensure_path_dir(path: String) -> void:
    var dir_path = path.get_base_dir()
    if not DirAccess.dir_exists_absolute(dir_path):
        DirAccess.make_dir_recursive_absolute(dir_path)

func _send_result(client: WebSocketPeer, id, result) -> void:
    var response = {
        "jsonrpc": "2.0",
        "result": result,
        "id": id
    }
    client.send_text(JSON.stringify(response))

func _send_error(client: WebSocketPeer, id, code, message) -> void:
    var response = {
        "jsonrpc": "2.0",
        "error": {"code": code, "message": message},
        "id": id
    }
    client.send_text(JSON.stringify(response))
