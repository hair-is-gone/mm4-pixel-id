const express = require('express');
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
app.set('trust proxy', true); // 信任代理，用于获取真实公网 IP
const port = 3000;
const SECURITY_FILE = path.join(__dirname, '.fbid_security.json');

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static('public'));



// 安全配置管理
function getSecurityConfig() {
    if (fs.existsSync(SECURITY_FILE)) {
        return JSON.parse(fs.readFileSync(SECURITY_FILE, 'utf8'));
    }
    return {};
}

function saveSecurityConfig(config) {
    fs.writeFileSync(SECURITY_FILE, JSON.stringify(config, null, 2));
}

// 统一记录访问历史
function logAccess(ip, username) {
    const security = getSecurityConfig();
    const clientIp = (ip || 'unknown').replace('::ffff:', '');
    
    // 如果上一次记录跟这次一样（且时间不到 1 分钟），则不重复记录以节省空间
    const lastEntry = security.loginHistory && security.loginHistory[0];
    const now = new Date();
    
    const historyEntry = {
        time: now.toLocaleString('zh-CN'),
        username: username || 'unknown',
        ip: clientIp
    };

    if (!security.loginHistory) security.loginHistory = [];
    
    // 简单的去重逻辑：如果 IP 没变且在 1 分钟内，则不新增记录
    if (lastEntry && lastEntry.ip === clientIp) {
        const lastTime = new Date(lastEntry.time);
        if (now - lastTime < 60000) return; 
    }

    security.loginHistory.unshift(historyEntry);
    if (security.loginHistory.length > 10) { // 稍微增加保留条数
        security.loginHistory = security.loginHistory.slice(0, 10);
    }
    
    saveSecurityConfig(security);
}

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

    // 登录接口：SSH 验证 (仅作为测试)
app.post('/api/login', (req, res) => {
    let { host, port, username, privateKey, passphrase } = req.body;
    if (!host || !username || !privateKey) {
        return res.status(400).json({ error: '请填写完整的连接信息' });
    }

    // 格式清洗：不仅处理换行符，还去除前后空格并确保结尾有且只有一个换行
    privateKey = privateKey.trim().replace(/\r\n/g, '\n') + '\n';
    console.log(`[SSH Debug] 收到 Host: ${host}, 私钥头部预览: ${privateKey.substring(0, 50).replace(/\n/g, '\\n')}...`);

    const attemptConnect = (pw) => {
        return new Promise((resolve, reject) => {
            const conn = new Client();
            const config = {
                host,
                port: parseInt(port) || 22,
                username,
                privateKey,
                passphrase: pw,
                readyTimeout: 10000
            };

            conn.on('ready', () => {
                conn.end();
                resolve();
            }).on('error', (err) => {
                conn.end();
                reject(err);
            }).connect(config);
        });
    };

    // 执行尝试策略
    (async () => {
        try {
            // 1. 先尝试直接连接 (不管是否传了密码)
            await attemptConnect(passphrase || undefined);
            logAccess(req.ip, username);
            return res.json({ success: true, message: '认证成功' });
        } catch (err) {
            // 2. 如果报错说需要密码，但没给，则尝试空字符串
            if (err.message.includes('No passphrase given') || err.message.includes('Encrypted')) {
                try {
                    console.log("[SSH] 检测到加密头，尝试空密码静默解密...");
                    await attemptConnect("");
                    logAccess(req.ip, username);
                    return res.json({ success: true, message: '认证成功 (空密码)' });
                } catch (retryErr) {
                    return res.status(401).json({ error: `私钥解密失败: ${retryErr.message} (该私钥可能真的有密码)` });
                }
            }
            res.status(401).json({ error: `SSH 认证失败: ${err.message}` });
        }
    })();
});



// 获取项目列表 (接收 sshConfig)
app.post('/api/projects', (req, res) => {
    const { sshConfig } = req.body;
    if (!sshConfig) return res.status(401).json({ error: '请先登录' });
    
    logAccess(req.ip, sshConfig.username);
    
    const conn = createClient(res);
    // 预处理私钥：确保 Windows 换行符不干扰库的解析
    if (sshConfig && sshConfig.privateKey) {
        sshConfig.privateKey = sshConfig.privateKey.replace(/\r\n/g, '\n');
        if (!sshConfig.passphrase) sshConfig.passphrase = "";
    }
    conn.on('ready', () => {
        console.log(`[SSH] 开始扫描项目: ${sshConfig.host}`);
        const aggCmd = "find /home/ubuntu/project -type f -name 'index.html' | grep '/dist/index.html' | xargs grep -H \"fbq(['\\\"\\']init\"";
        
        conn.exec(aggCmd, (err, stream) => {
            if (err || !stream) {
                console.error(`[SSH] 扫描执行失败: ${err ? err.message : 'Unknown'}`);
                conn.end();
                return res.status(500).json({ error: err ? err.message : 'Failed to create agg stream' });
            }
            
            let data = '';
            stream.on('data', d => data += d);
            stream.on('stderr', d => console.error('Agg Stderr:', d.toString()));
            stream.on('close', () => {
                const lines = data.trim().split('\n').filter(Boolean);
                const results = lines.map(line => {
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
                
                const security = getSecurityConfig();
                res.json({ 
                    host: sshConfig.host, 
                    projects: results,
                    loginHistory: security.loginHistory || []
                });
                console.log(`[SSH] 扫描完成，关闭连接: ${sshConfig.host}`);
                conn.end(); // 必须关闭连接
            });
        });
    }).on('end', () => {
        console.log(`[SSH] 会话已安全关闭: ${sshConfig.host}`);
    }).connect(sshConfig); // sshConfig 已经包含 passphrase
});

// 更新 FBID (接收 sshConfig)
app.post('/api/update-fbid', (req, res) => {
    const { path: filePath, fbid, sshConfig } = req.body;
    if (!sshConfig) return res.status(401).json({ error: '请先登录' });
    if (!filePath || !fbid) return res.status(400).json({ error: 'Missing path or fbid' });

    const conn = createClient(res);
    conn.on('ready', () => {
        console.log(`[SSH] 开始更新 FBID: ${filePath}`);
        conn.exec(`cat "${filePath}"`, (err, stream) => {
            if (err) { console.error(`[SSH] 更新失败(cat): ${err.message}`); conn.end(); return res.status(500).json({ error: err.message }); }
            let content = '';
            stream.on('data', d => content += d);
            stream.on('close', () => {
                const match = content.match(/fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d+)['"]\s*\)/);
                if (!match) { console.warn(`[SSH] 未定位到 FBID 代码: ${filePath}`); conn.end(); return res.status(400).json({ error: '无法定位 FBID' }); }
                
                const sedCommand = `sed -i "s/fbq\\s*(\\s*['\\\"\\\']init['\\\"\\\']\\s*,\\s*['\\\"\\\'][0-9]\\+['\\\"\\\']\\s*)/fbq('init', '${fbid}')/g" "${filePath}"`;
                conn.exec(sedCommand, (err, s) => {
                    if (err) { console.error(`[SSH] 更新执行失败(sed): ${err.message}`); conn.end(); return res.status(500).json({ error: err.message }); }
                    s.on('close', (code) => {
                        console.log(`[SSH] 更新指令执行完毕 (Exit Code: ${code}): ${filePath}`);
                        conn.end();
                        if (code === 0) res.json({ success: true });
                        else res.status(500).json({ error: `Exit code ${code}` });
                    });
                });
            });
        });
    }).on('end', () => {
        console.log(`[SSH] 更新会话已安全关闭: ${sshConfig.host}`);
    }).connect(sshConfig); // sshConfig 已经包含 passphrase
});

app.listen(port, () => {
    console.log(`FBID Manager listening at http://localhost:${port}`);
});
