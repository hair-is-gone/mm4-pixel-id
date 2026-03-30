const express = require('express');
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

const app = express();
const port = 3000;
const SECURITY_FILE = path.join(__dirname, '.fbid_security.json');

app.use(bodyParser.json());
app.use(express.static('public'));

let activeSshConfig = null;
let pendingSecret = null; // 临时存放待绑定的 Secret

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

// 登录接口：SSH 验证 + 2FA 校验
app.post('/api/login', (req, res) => {
    const { host, port, username, privateKey, twoFactorCode } = req.body;
    if (!host || !username || !privateKey) {
        return res.status(400).json({ error: '请填写完整的连接信息' });
    }

    const testConfig = {
        host,
        port: parseInt(port) || 22,
        username,
        privateKey
    };

    const security = getSecurityConfig();
    
    // 如果已启用 2FA，先验证验证码（在 SSH 验证前或后均可，这里选择先验证 SSH 确保凭证正确）
    const conn = new Client();
    conn.on('ready', async () => {
        conn.end();

        // SSH 成功后，检查 2FA
        if (!security.twoFactorSecret) {
            // 尚未绑定 2FA，生成绑定二维码
            const secret = speakeasy.generateSecret({ name: `FBID-Manager (${host})` });
            pendingSecret = secret.base32;
            const qrUrl = await qrcode.toDataURL(secret.otpauth_url);
            return res.json({ success: true, needs2FA: true, isNew: true, qrCode: qrUrl });
        }

        // 已有 2FA，需要校验 Code
        if (!twoFactorCode) {
            return res.status(401).json({ error: '需要输入谷歌验证码', needs2FA: true });
        }

        const verified = speakeasy.totp.verify({
            secret: security.twoFactorSecret,
            encoding: 'base32',
            token: twoFactorCode
        });

        if (!verified) {
            return res.status(401).json({ error: '谷歌验证码不正确' });
        }

        // 认证成功，建立会话
        activeSshConfig = testConfig;

        // 记录访问历史 (客户端 IP)
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const historyEntry = {
            time: new Date().toLocaleString('zh-CN'),
            username: username,
            ip: clientIp.replace('::ffff:', '') // 处理 IPv4 映射
        };

        if (!security.loginHistory) security.loginHistory = [];
        security.loginHistory.unshift(historyEntry);
        if (security.loginHistory.length > 5) security.loginHistory = security.loginHistory.slice(0, 5);
        
        saveSecurityConfig(security);

        res.json({ success: true, message: '登录成功' });
    }).on('error', (err) => {
        res.status(401).json({ error: `SSH 连接失败: ${err.message}` });
    }).connect(testConfig);
});

// 确认 2FA 绑定
app.post('/api/confirm-2fa', (req, res) => {
    const { code } = req.body;
    if (!pendingSecret || !code) return res.status(400).json({ error: '无效的绑定请求' });

    const verified = speakeasy.totp.verify({
        secret: pendingSecret,
        encoding: 'base32',
        token: code
    });

    if (verified) {
        const security = getSecurityConfig();
        security.twoFactorSecret = pendingSecret;
        saveSecurityConfig(security);
        pendingSecret = null;
        res.json({ success: true, message: '2FA 绑定成功，请重新登录' });
    } else {
        res.status(401).json({ error: '验证码校验失败，请重试' });
    }
});

// 获取项目列表
app.get('/api/projects', (req, res) => {
    if (!activeSshConfig) return res.status(401).json({ error: '请先登录' });
    
    const conn = createClient(res);
    conn.on('ready', () => {
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
                    host: activeSshConfig.host, 
                    projects: results,
                    loginHistory: security.loginHistory || []
                });
            });
        });
    }).connect(activeSshConfig);
});

// 更新 FBID
app.post('/api/update-fbid', (req, res) => {
    if (!activeSshConfig) return res.status(401).json({ error: '请先登录' });
    const { path: filePath, fbid } = req.body;
    if (!filePath || !fbid) return res.status(400).json({ error: 'Missing path or fbid' });

    const conn = createClient(res);
    conn.on('ready', () => {
        conn.exec(`cat "${filePath}"`, (err, stream) => {
            if (err) return res.status(500).json({ error: err.message });
            let content = '';
            stream.on('data', d => content += d);
            stream.on('close', () => {
                const match = content.match(/fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d+)['"]\s*\)/);
                if (!match) { conn.end(); return res.status(400).json({ error: '无法定位 FBID' }); }
                
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
    }).connect(activeSshConfig);
});

app.listen(port, () => {
    console.log(`FBID Manager listening at http://localhost:${port}`);
});
