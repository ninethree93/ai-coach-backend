// server/api/index.js
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- 1. 优化AI“教练人格”系统指令 (核心提升) ---
const SYSTEM_PROMPT = `你是一名专业、严谨且经验丰富的全能运动教练，名叫“Coach AI”。你的核心职责是基于科学原理，为用户提供安全、有效、个性化的运动指导。请严格遵循以下原则与用户对话：

**核心行为准则：**
1.  **专业与安全第一**：所有建议必须基于公认的运动科学。在涉及潜在伤病风险、医疗或营养补充剂问题时，必须明确声明“这不能替代专业医疗建议，请咨询医生”。
2.  **结构化与清晰**：回答应逻辑清晰。制定计划时，使用“训练周期”、“每周安排”、“动作组数/次数”、“进阶原则”等专业框架。可以安排的强度大一点，激进一点。
3.  **上下文连贯**：你必须主动记住并引用对话历史中用户提过的目标、水平、伤病史和偏好。每次回答都应体现对用户个人情况的持续跟踪。
4.  **主动引导与澄清**：当用户目标模糊（如“我想练得好一点”）或信息不全时，主动、有条理地追问关键信息（目标、水平、时间、伤病史）。
5. 当用户提出立刻给出计划或者其他强制要求的时候，听从用户安排。

**对话风格要求：**
- **语气**：保持冷静、直接、鼓励但不过度热情。多用短句和口语化表达，避免学术论文式的冗长。
- **互动**：像一个真实的教练，可以反问（如“上次提到的膝盖不适，最近感觉如何？”），并在后续对话中回顾用户进展。

**初始化流程：**
当新用户或新对话开始时，若信息不全，你必须按此顺序引导：
1.  “你的具体运动目标是什么？（例如：3个月减重5公斤、6个月完成半马、增肌塑形）”
2.  “你目前的运动水平如何？（每周运动频率、类型、年限）”
3.  “每周能安排几天训练？每次大概多久？”
4.  “是否有需要特别注意的旧伤或健康状况？”
在获得上述信息前，提供的计划应是框架性和提示性的。`;

// --- 2. 调整记忆管理（保留更多轮次以增强连贯性）---
const MEMORY_DIR = path.join(__dirname, 'memories');
if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function getUserMemoryPath(userId) {
    const safeUserId = userId.replace(/[^a-z0-9]/gi, '_');
    return path.join(MEMORY_DIR, `${safeUserId}.json`);
}

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
    return [];
}

function saveUserMemory(userId, messages) {
    try {
        const filePath = getUserMemoryPath(userId);
        // 将保留的对话轮次从10增加到20，以维持更好的上下文
        const recentMessages = messages.slice(-20);
        fs.writeFileSync(filePath, JSON.stringify(recentMessages, null, 2), 'utf8');
    } catch (error) {
        console.error(`保存用户 ${userId} 的记忆失败:`, error);
    }
}

// --- 3. 核心API：优化后的对话处理逻辑 ---
app.post('/api/chat', async (req, res) => {
    const { message, userId = 'default_user' } = req.body;

    if (!message || message.trim() === '') {
        return res.status(400).json({ error: '消息内容不能为空' });
    }

    console.log(`[${new Date().toLocaleTimeString()}] 用户 ${userId}: ${message}`);

    try {
        // 1. 读取用户历史对话
        const userMessages = readUserMemory(userId);

        // 2. 构建发送给DeepSeek API的消息数组
        const messagesForAI = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...userMessages,
            { role: 'user', content: message.trim() }
        ];

        // 3. 调用 DeepSeek API (关键：优化生成参数)
        const deepseekResponse = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat', // 确保使用正确的模型名称
                messages: messagesForAI,
                // 调整核心参数以平衡创造性与一致性
                temperature: 0.7,       // 维持适度创造性，适合计划生成
                max_tokens: 1200,       // 稍微增加，允许更详细的计划说明
                top_p: 0.9,            // 与temperature配合，使回答更聚焦
                frequency_penalty: 0.2, // 降低词语重复，使表达更丰富
                presence_penalty: 0.1,  // 轻微鼓励引入新话题，避免总是重复相同建议
                // stream: false,       // 非流式，如需更快的响应感知可设为true并调整前端
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                timeout: 25000, // 适当增加超时时间
            }
        );

        // 4. 提取AI回复
        const aiReply = deepseekResponse.data.choices[0]?.message?.content?.trim() || '教练思考中，请稍候再试。';

        // 5. 保存本轮对话到历史
        const updatedMessages = [
            ...userMessages,
            { role: 'user', content: message.trim() },
            { role: 'assistant', content: aiReply }
        ];
        saveUserMemory(userId, updatedMessages);

        console.log(`[${new Date().toLocaleTimeString()}] AI教练: ${aiReply.substring(0, 80)}...`);

        // 6. 返回成功响应
        res.json({
            success: true,
            reply: aiReply,
            userId: userId,
            // 可选：返回令牌使用情况用于监控
            usage: deepseekResponse.data.usage
        });

    } catch (error) {
        console.error('调用AI接口出错:', error.message);
        let userFriendlyError = 'AI教练暂时开小差了，请稍后再试。';
        let statusCode = 500;

        if (error.code === 'ECONNABORTED') {
            userFriendlyError = '请求超时了，请检查网络或稍后重试。';
        } else if (error.response?.status === 401) {
            userFriendlyError = '服务认证失败，请联系管理员。';
            statusCode = 401;
        } else if (error.response?.status === 429) {
            userFriendlyError = '提问太频繁啦，请休息一分钟再试。';
            statusCode = 429;
        } else if (error.response?.data?.error?.message) {
            // 尝试传递更具体的后端错误信息
            userFriendlyError = `服务暂时繁忙: ${error.response.data.error.message}`;
        }

        res.status(statusCode).json({
            success: false,
            error: userFriendlyError
        });
    }
});

// --- 4. 辅助接口 ---
app.get('/api/health', (req, res) => {
    res.json({
        status: '在线',
        service: 'AI运动教练后端',
        model: 'deepseek-chat',
        timestamp: new Date().toISOString()
    });
});

app.get('/', (req, res) => {
    res.json({
        message: '🎯 AI 运动教练后端服务已上线！',
        endpoints: {
            '对话接口': 'POST /api/chat',
            '健康检查': 'GET /api/health'
        },
        timestamp: new Date().toISOString()
    });
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🚀 AI教练后端服务器已启动！`);
        console.log(`📍 本地访问地址: http://localhost:${PORT}`);
        console.log(`⚠️  请确保已配置 DEEPSEEK_API_KEY 环境变量`);
    });
}

export default app;