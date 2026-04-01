import json
import socket
from typing import Any, Dict
from mcp.server.fastmcp import FastMCP

# MCPサーバーのインスタンス化 (Blender制御用)
mcp = FastMCP("Blender Controller")

BLENDER_HOST = "127.0.0.1"
BLENDER_PORT = 8123

def send_to_blender(action: str, kwargs: Dict[str, Any] = None) -> Dict[str, Any]:
    """Blender内部で動いている Socket サーバーに JSON を送信し、レスポンスを受け取る"""
    cmd = {"action": action, "kwargs": kwargs or {}}
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(10.0) # Render等時間がかかる場合があるため長め
            s.connect((BLENDER_HOST, BLENDER_PORT))
            s.sendall((json.dumps(cmd) + '\n').encode('utf-8'))
            
            # 受信データのバッファリング
            data = b""
            while True:
                chunk = s.recv(4096)
                if not chunk:
                    break
                data += chunk
                
            return json.loads(data.decode('utf-8'))
    except ConnectionRefusedError:
        return {"status": "error", "message": "Blender MCP server is not running. Please enable it in the Blender Addon preferences."}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@mcp.tool()
def blender_get_objects() -> str:
    """Get a list of all objects currently in the Blender scene."""
    result = send_to_blender("get_objects")
    return json.dumps(result, indent=2)

@mcp.tool()
def blender_add_cube(size: float = 2.0, x: float = 0.0, y: float = 0.0, z: float = 0.0) -> str:
    """Add a new cube to the Blender scene at the specified coordinates."""
    result = send_to_blender("add_cube", {"size": size, "location": [x, y, z]})
    return json.dumps(result, indent=2)

@mcp.tool()
def blender_delete_all() -> str:
    """Delete all objects from the current Blender scene."""
    result = send_to_blender("delete_all")
    return json.dumps(result, indent=2)

@mcp.tool()
def blender_execute_python(code: str) -> str:
    """Execute arbitrary Python code using the Blender API (bpy) inside Blender."""
    result = send_to_blender("execute_python", {"code": code})
    return json.dumps(result, indent=2)

@mcp.tool()
def blender_render(filepath: str = "//render.png") -> str:
    """Render the current scene and save the image to the specified filepath."""
    result = send_to_blender("render", {"filepath": filepath})
    return json.dumps(result, indent=2)

@mcp.tool()
def blender_save_blend(filepath: str) -> str:
    """Save the current Blender project (.blend) to the specified filepath."""
    result = send_to_blender("save_blend", {"filepath": filepath})
    return json.dumps(result, indent=2)


if __name__ == "__main__":
    # MCPサーバーの起動処理 (標準入出力経由で通信)
    print("Starting Blender MCP Server...", flush=True)
    mcp.run(transport='stdio')
