// server/api/index.js
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

// --- 解决 ES6 模块中 __dirname 的问题（Node.js 新版本需要）---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Vercel 会提供自己的端口，本地开发默认用 3000
const PORT = process.env.PORT || 3000;

// --- 中间件：让服务器能处理JSON和跨域请求 ---
app.use(cors()); // 允许所有来源的请求（适合开发阶段）
app.use(express.json()); // 解析请求体中 JSON 格式的数据

// --- 1. 定义AI教练的“人格”与规则（系统指令）---
const SYSTEM_PROMPT = `你是一位专业的全能运动教练，涵盖跑步、健身、力量训练、有氧运动、拳击格斗、滑雪等全部运动，严谨且安全第一。请遵循以下规则与用户对话：
1. 当用户首次咨询或信息不全时，你必须主动询问以下核心信息，缺一不可：
   - 运动目标与时间（例如：3个月减重5公斤、6个月完成马拉松、增肌塑形）
   - 当前运动水平（例如：每周运动频率、类型、经验）
   - 每周可用训练天数
   - 有无重要伤病史
2. 根据用户信息，制定科学、个性化的训练计划，考虑不同运动类型的结合（如有氧+力量+柔韧性训练）。
3. 语气严厉冷静口语化不ai`;

// --- 2. 简易文件记忆库（用于本地测试，Vercel上无效）---
const MEMORY_DIR = path.join(__dirname, 'memories');
// 确保存储记忆的文件夹存在
if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

// 根据用户ID生成对应的记忆文件路径
function getUserMemoryPath(userId) {
    // 简单处理，防止文件名非法字符
    const safeUserId = userId.replace(/[^a-z0-9]/gi, '_');
    return path.join(MEMORY_DIR, `${safeUserId}.json`);
}

// 读取某个用户的对话历史
function readUserMemory(userId) {
    try {
        const filePath = getUserMemoryPath(userId);
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error(`读取用户 ${userId} 的记忆失败:`, error);
    }
    return []; // 默认返回空数组
}

// 保存某个用户的对话历史（最多保留最近10轮）
function saveUserMemory(userId, messages) {
    try {
        const filePath = getUserMemoryPath(userId);
        const recentMessages = messages.slice(-10); // 只保留最新10条
        fs.writeFileSync(filePath, JSON.stringify(recentMessages, null, 2), 'utf8');
    } catch (error) {
        console.error(`保存用户 ${userId} 的记忆失败:`, error);
    }
}

// --- 3. 核心API：处理与小程序的对话 ---
app.post('/api/chat', async (req, res) => {
    // 从请求体中获取用户发送的消息和唯一标识
    const { message, userId = 'default_user' } = req.body;

    // 简单验证
    if (!message || message.trim() === '') {
        return res.status(400).json({ error: '消息内容不能为空' });
    }

    console.log(`[${new Date().toLocaleTimeString()}] 用户 ${userId}: ${message}`);

    try {
        // +++ 新增的“调试侦探”代码 +++
        console.log('[调试侦探] 密钥前8位是：', process.env.DEEPSEEK_API_KEY ? process.env.DEEPSEEK_API_KEY.substring(0, 8) + '...' : '警报：密钥未定义！');
        // +++ 结束新增 +++
        // 1. 读取这个用户的历史对话
        const userMessages = readUserMemory(userId);

        // 2. 构建发送给DeepSeek API的对话格式
        const messagesForAI = [
            { role: 'system', content: SYSTEM_PROMPT }, // 系统指令
            ...userMessages,                            // 历史对话
            { role: 'user', content: message }          // 当前新消息
        ];

        // 3. 调用 DeepSeek API
        const deepseekResponse = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat', // 指定模型
                messages: messagesForAI,
                temperature: 0.7, // 控制回答随机性，0-1之间，越高越随机
                max_tokens: 1000, // 回复的最大长度
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, // 从环境变量读取密钥
                    'Content-Type': 'application/json',
                },
                timeout: 20000, // 设置20秒超时
            }
        );

        // 4. 提取AI的回复
        const aiReply = deepseekResponse.data.choices[0]?.message?.content || '抱歉，我暂时想不出好的回答。';

        // 5. 将本轮对话存入记忆
        const updatedMessages = [
            ...userMessages,
            { role: 'user', content: message },
            { role: 'assistant', content: aiReply }
        ];
        saveUserMemory(userId, updatedMessages);

        console.log(`[${new Date().toLocaleTimeString()}] AI教练: ${aiReply.substring(0, 50)}...`);

        // 6. 将回复成功返回给小程序
        res.json({
            success: true,
            reply: aiReply,
            userId: userId
        });

    } catch (error) {
        // 错误处理
        console.error('调用AI接口出错:', error.message);
        let userFriendlyError = 'AI教练暂时开小差了，请稍后再试。';

        if (error.code === 'ECONNABORTED') {
            userFriendlyError = '请求超时了，可能是网络有点慢。';
        } else if (error.response?.status === 401) {
            userFriendlyError = '服务配置有误（API密钥错误）。';
        } else if (error.response?.status === 429) {
            userFriendlyError = '提问太频繁啦，请休息一下再试。';
        }

        res.status(500).json({
            success: false,
            error: userFriendlyError
        });
    }
});

// --- 4. 辅助接口（用于健康检查）---
app.get('/api/health', (req, res) => {
    res.json({ status: '在线', service: 'AI教练后端', timestamp: new Date().toISOString() });
});

// --- 添加根路径路由 ---
app.get('/', (req, res) => {
    res.json({
        message: '🎯 AI 教练后端服务已上线！',
        endpoints: {
            '聊天接口': 'POST /api/chat',
            '健康检查': 'GET /api/health',
            '当前状态': 'GET /'
        },
        timestamp: new Date().toISOString(),
        deployed_on: 'Vercel'
    });
});

// --- 5. 启动本地开发服务器 ---
// 注意：这段代码在部署到Vercel时不会运行，Vercel会直接使用 `app`。
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🚀 AI教练后端服务器已启动！`);
        console.log(`📍 本地访问地址: http://localhost:${PORT}`);
        console.log(`📝 对话接口: POST http://localhost:${PORT}/api/chat`);
        console.log(`❤️  健康检查: GET http://localhost:${PORT}/api/health`);
        console.log(`⚠️  请确保已在 .env 文件中配置 DEEPSEEK_API_KEY`);
    });
}

// --- 6. 关键导出 ---
// Vercel 等Serverless平台需要这个导出
export default app;