import { handleApi } from './handler.mjs';

export default {
  async fetch(request, env) {
    return handleApi(request, {
      env,
      requireOrigin: true,
      // Operational metadata only; never log movement, AI text, or credentials.
      onDiagnostic: ({ code, elapsedMs, attempts, stage, requestBytes, providerMs,
        inputTokens, outputTokens, thoughtTokens }) => {
        console.info(JSON.stringify({ event: 'analysis', code, elapsedMs, attempts, stage,
          requestBytes, providerMs, inputTokens, outputTokens, thoughtTokens }));
      },
      checkLimit: async req => {
        // These Cloudflare counters are shared within a location, not a global billing cap.
        // The default Gemini project should stay on the free tier.
        if (!env.ANALYSIS_LIMITER || !env.TOTAL_LIMITER) return false;
        const visitor = req.headers.get('CF-Connecting-IP') || 'unknown';
        const perVisitor = await env.ANALYSIS_LIMITER.limit({ key: visitor });
        if (!perVisitor.success) return false;
        return (await env.TOTAL_LIMITER.limit({ key: 'analysis' })).success;
      },
    });
  },
};
