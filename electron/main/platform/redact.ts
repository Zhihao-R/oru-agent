/**
 * 出站通用脱敏（理想架构 S05 · channels「密钥等敏感信息不外发」）——
 * 回发平台 / 落盘前抹掉密钥本体。覆盖四类：
 *  ① 已知形态 token（飞书 t-/u-/a-、Bearer、常见厂商 key 前缀、JWT）；
 *  ② 赋值语境（API_KEY=值、secret: 值）——厂商前缀穷举不完，靠「键名含密钥词」兜底；
 *  ③ PEM 私钥块整块；
 *  ④ 密钥链路径。
 *
 * 取舍：不做泛熵检测（长 hex/base64 一律放过）——git SHA、消息 ID 都是长串，误伤面太大；
 * 防漏靠赋值语境兜底（红线 1 场景里密钥几乎总带着键名出现）。普通文字（中文叙述、
 * 英文句子里的 key/token 词）不动，不做过度脱敏。
 */

/** 飞书 access token 前缀（t- 租户 / u- 用户 / a- 应用）后跟长串。 */
const FEISHU_TOKEN = /\b[tua]-[A-Za-z0-9._-]{8,}/g;
const BEARER = /Bearer\s+[A-Za-z0-9._-]+/gi;
const KEYCHAIN_PATH = /\S*Keychains?\/\S+/g;

/** 常见厂商 key 前缀（OpenAI/Anthropic sk-、GitHub、Slack、AWS、Google、GitLab、npm）。 */
const VENDOR_KEYS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
];

/** JWT 三段式（header.payload.signature，各段 base64url）。 */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/** PEM 私钥块（含 RSA/EC/OPENSSH 等变体）整块抹掉。 */
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * 赋值语境：键名含密钥词（key/secret/token/password/credential）且后跟 = 或 : 加值。
 * 只抹值、留键名（读者仍知道这行是什么）。键名词后必须紧跟赋值符——
 * 普通句子「The API key rotation…」「token 已过期」无赋值符，不触发。
 */
const ASSIGNMENT = /([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|credential|private[_-]?key)[A-Za-z0-9_.-]*\s*[=:]\s*)("[^"]+"|'[^']+'|[^\s"',;]+)/gi;

/** 抹掉密钥本体；普通文字（含中文叙述）不动。 */
export function redactSecrets(text: string): string {
  let out = text
    .replace(PEM_PRIVATE_KEY, '***')
    .replace(BEARER, 'Bearer ***')
    .replace(JWT, '***')
    .replace(ASSIGNMENT, '$1***')
    .replace(FEISHU_TOKEN, '***')
    .replace(KEYCHAIN_PATH, '***');
  for (const re of VENDOR_KEYS) out = out.replace(re, '***');
  return out;
}
