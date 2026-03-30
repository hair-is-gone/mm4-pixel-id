const express = require('express');
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const port = 3000;

app.use(bodyParser.json());
app.use(express.static('public'));

const sshConfig = {
    host: '15.207.6.184',
    port: 22,
    username: 'root',
    privateKey: fs.readFileSync('/Users/alex/Documents/id_rsa'),
    // 如果您的私钥有密码短语，请取消下面注释并填入：
    // passphrase: 'YOUR_PASSPHRASE'
};

function createClient(res) {
    const conn = new Client();
    conn.on('error', (err) => {
        console.error('SSH Client Error:', err);
        if (res && !res.headersSent) {
            res.status(500).json({ error: `SSH 认证或连接失败: ${err.message}` });
        }
    });
    return conn;
}

// 获取项目列表及对应的 FBID
app.get('/api/projects', (req, res) => {
    const conn = createClient(res);
    conn.on('ready', () => {
        // 使用聚合命令：一次性找到所有 index.html 并提取包含 fbq 的行及其完整路径
        // 输出格式示例：/path/to/index.html:  fbq('init', '123456');
        const aggCmd = "find /home/ubuntu/project -type f -name 'index.html' | grep '/dist/index.html' | xargs grep -H \"fbq(['\\\"\\']init\"";
        
        conn.exec(aggCmd, (err, stream) => {
            if (err || !stream) return res.status(500).json({ error: err ? err.message : 'Failed to create agg stream' });
            
            let data = '';
            stream.on('data', d => data += d);
            stream.on('stderr', d => console.error('Agg Stderr:', d.toString()));
            stream.on('close', () => {
                conn.end();
                const lines = data.trim().split('\n').filter(Boolean);
                const results = lines.map(line => {
                    // line 格式: /path/to/file:content
                    const colonIndex = line.indexOf(':');
                    if (colonIndex === -1) return null;
                    
                    const filePath = line.substring(0, colonIndex).trim();
                    const content = line.substring(colonIndex + 1);
                    const match = content.match(/fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d+)['"]\s*\)/);
                    
                    return {
                        path: filePath,
                        name: filePath.split('/').slice(-3, -2)[0] || 'unknown',
                        fbid: match ? match[1] : 'Not Found'
                    };
                }).filter(Boolean);
                
                res.json(results);
            });
        });
    }).connect(sshConfig);
});

// 更新项目的 FBID
app.post('/api/update-fbid', (req, res) => {
    const { path: filePath, fbid } = req.body;
    if (!filePath || !fbid) return res.status(400).json({ error: 'Missing path or fbid' });

    const conn = createClient(res);
    conn.on('ready', () => {
        // 先读取文件，找到确切的 fbq('init') 字符串
        conn.exec(`cat "${filePath}"`, (err, stream) => {
            if (err) return res.status(500).json({ error: err.message });
            let content = '';
            stream.on('data', d => content += d);
            stream.on('close', () => {
                const match = content.match(/fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d+)['"]\s*\)/);
                if (!match) {
                    conn.end();
                    return res.status(400).json({ error: '无法在 HTML 中定位原 FBID 标志' });
                }
                
                // 原有的完整匹配字符串
                const oldCall = match[0];
                // 构造对应的 sed 替换命令。注意转义单引号。
                // 我们简单的替换 match[1] 所在的数字部分
                const newCall = oldCall.replace(match[1], fbid);
                
                // 为了 sed 安全，我们将 oldCall 中的特殊字符稍微处理一下
                const escapedOld = oldCall.replace(/['"]/g, '.');
                const escapedNew = newCall.replace(/'/g, "'\\''");

                // 使用更加简单的替换策略: 替换 fbq('init', '数字') 这个整体
                const sedCommand = `sed -i "s/fbq\\s*(\\s*['\\\"\\\']init['\\\"\\\']\\s*,\\s*['\\\"\\\'][0-9]\\+['\\\"\\\']\\s*)/fbq('init', '${fbid}')/g" "${filePath}"`;

                conn.exec(sedCommand, (err, s) => {
                    if (err) { conn.end(); return res.status(500).json({ error: err.message }); }
                    s.on('close', (code) => {
                        conn.end();
                        if (code === 0) res.json({ success: true });
                        else res.status(500).json({ error: `Exit code ${code}` });
                    });
                });
            });
        });
    }).connect(sshConfig);
});

app.listen(port, () => {
    console.log(`FBID Manager listening at http://localhost:${port}`);
});
