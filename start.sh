#!/bin/bash

# --- 配置区 ---
APP_NAME="fbid-manager"
PORT=3000
# --------------

echo "🚀 检查运行环境..."

# 1. 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未安装 Node.js，请先前往 https://nodejs.org 安装。"
    exit 1
fi

# 2. 检查并安装 PM2 (如果缺失)
if ! command -v pm2 &> /dev/null; then
    echo "⚠️  PM2 未安装，正在进行安装..."
    npm install -g pm2
    if [ $? -ne 0 ]; then
        echo "❌ 错误: PM2 安装失败，请尝试运行 'sudo npm install -g pm2'。"
        exit 1
    fi
fi

# 3. 安装依赖 (如果 node_modules 不存在)
if [ ! -d "node_modules" ]; then
    echo "📦 正在安装项目依赖..."
    npm install
fi

# 4. 启动/重启服务
echo "🔄 正在启动 fbid-manager 后台进程..."
pm2 delete $APP_NAME 2>/dev/null
pm2 start server.js --name $APP_NAME --watch

# 5. 保存列表及设置自启
pm2 save

echo "------------------------------------------------"
echo "🚀 正在检查开机自启配置..."
STARTUP_CHECK=$(pm2 startup | grep "sudo env PATH")
if [ ! -z "$STARTUP_CHECK" ]; then
    echo "⚠️  注意: 检侧到尚未配置开机自启，请复制下方命令并在终端执行:"
    echo ""
    echo "$STARTUP_CHECK"
    echo ""
    echo "执行完上面的命令后，请再次运行 'pm2 save'。"
else
    echo "✅ 开机自启已配置。"
fi

echo "------------------------------------------------"
echo "✅ 部署成功！服务已在后台运行。"
echo "🔗 本地访问: http://localhost:$PORT"
echo "📡 请确保你的 cpolar 正在转发 $PORT 端口"
echo "------------------------------------------------"
echo "💡 常用管理命令:"
echo " - 查看实时日志: pm2 logs $APP_NAME"
echo " - 查看运行状态: pm2 status"
echo " - 停止运行服务: pm2 stop $APP_NAME"
echo "------------------------------------------------"
