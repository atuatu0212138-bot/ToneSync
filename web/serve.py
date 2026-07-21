#!/usr/bin/env python3
"""ToneSync 开发服务器：所有响应带 Cache-Control: no-store。

python -m http.server 不发缓存头，浏览器的启发式缓存可能在代码更新后
继续使用旧的 ES Module，造成新旧模块错配（BUG-007：渲染循环因
调用不存在的方法而死亡，画布永久空白）。开发期一律用本脚本起服务：

    python3 web/serve.py [端口=8123]     # 项目根目录运行
    打开 http://localhost:8123/web/
"""
import http.server
import sys


class NoStoreHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass  # 静默访问日志


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    print(f"ToneSync dev server (no-store) → http://localhost:{port}/web/")
    http.server.ThreadingHTTPServer(("", port), NoStoreHandler).serve_forever()
