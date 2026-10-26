import { isAdminAuthenticated, errorResponse, jsonResponse } from '../_middleware';

export async function onRequestPost(context) {
    const { request, env } = context;

    // 1. 权限检查：必须是登录管理员
    if (!(await isAdminAuthenticated(request, env))) {
        return errorResponse('Unauthorized', 401);
    }

    try {
        const { messages } = await request.json();

        if (!messages || !Array.isArray(messages)) {
            return errorResponse('Messages array is required', 400);
        }

        // 2. 从数据库读取 AI 设置
        const keys = ['provider', 'apiKey', 'baseUrl', 'model'];
        const { results } = await env.NAV_DB.prepare(
            `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`
        ).bind(...keys).all();

        const settings = {};
        if (results) {
            results.forEach(row => {
                settings[row.key] = row.value;
            });
        }

        const provider = settings.provider || 'workers-ai';
        const apiKey = settings.apiKey;
        const baseUrl = settings.baseUrl;
        const model = settings.model;

        // 3. 根据不同的服务商处理请求
        if (provider === 'workers-ai') {
            if (!env.AI) {
                return errorResponse('Workers AI binding (env.AI) not found', 500);
            }
            // Workers AI 使用环境变量或固定模型
            const workerModel = env.WORKERS_AI_MODEL || '@cf/mistralai/mistral-small-3.1-24b-instruct';
            const response = await env.AI.run(workerModel, { messages });
            return jsonResponse({
                code: 200,
                data: response.response || response
            });

        } else if (provider === 'openai') {
            if (!apiKey) return errorResponse('OpenAI API Key 未在设置中配置', 500);
            if (!baseUrl) return errorResponse('OpenAI Base URL 未在设置中配置', 500);

            const openaiUrl = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
            const aiResponse = await fetch(openaiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: model || 'gpt-3.5-turbo',
                    messages: messages,
                    temperature: 0.7
                })
            });

            if (!aiResponse.ok) {
                const errText = await aiResponse.text();
                return errorResponse(`OpenAI API Error: ${errText}`, 500);
            }

            const data = await aiResponse.json();
            const content = data.choices?.[0]?.message?.content || '';
            return jsonResponse({
                code: 200,
                data: content
            });

        } else if (provider === 'gemini') {
            if (!apiKey) return errorResponse('Gemini API Key 未在设置中配置', 500);

            const geminiModel = model || 'gemini-1.5-flash';
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;

            // 将 OpenAI 格式的 messages 转换为 Gemini 格式
            const contents = messages
                .filter(m => m.role !== 'system')
                .map(m => ({
                    role: m.role === 'user' ? 'user' : 'model',
                    parts: [{ text: m.content }]
                }));

            const systemMsg = messages.find(m => m.role === 'system');

            const payload = {
                contents: contents,
                generationConfig: { temperature: 0.7 }
            };

            if (systemMsg) {
                payload.systemInstruction = { parts: [{ text: systemMsg.content }] };
            }

            const aiResponse = await fetch(geminiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                body: JSON.stringify(payload)
            });

            if (!aiResponse.ok) {
                const errText = await aiResponse.text();
                return errorResponse(`Gemini API Error: ${errText}`, 500);
            }

            const data = await aiResponse.json();
            const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

            return jsonResponse({
                code: 200,
                data: content
            });

        } else {
            return errorResponse(`Unsupported provider: ${provider}`, 400);
        }

    } catch (e) {
        console.error('AI Chat API error:', e);
        return errorResponse(`Server Error: ${e.message}`, 500);
    }
}