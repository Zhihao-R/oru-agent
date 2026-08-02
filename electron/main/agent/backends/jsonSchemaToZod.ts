/**
 * 极简 JSON Schema → zod 转换器
 *
 * 只支持 v0.1 工具实际用到的字段类型：
 *   string / number / boolean / array / object / enum / required[]
 *
 * 不打算做通用——遇到不认识的字段直接 z.any()。
 * 复杂场景未来再换 npm 上的 json-schema-to-zod 包。
 */
import { z, type ZodTypeAny } from 'zod';

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  description?: string;
};

export function jsonSchemaToZod(schema: object): z.ZodTypeAny {
  return convert(schema as JsonSchema);
}

function convert(schema: JsonSchema): ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.any();

  // enum 优先
  if (schema.enum && schema.enum.length > 0) {
    const enumSchema = z.enum(schema.enum as [string, ...string[]]);
    return schema.description ? enumSchema.describe(schema.description) : enumSchema;
  }

  // type 是数组：处理 nullable / union（JSON Schema draft-04+ 风格）
  if (Array.isArray(schema.type)) {
    const types = schema.type;
    const hasNull = types.includes('null');
    const nonNull = types.filter((t) => t !== 'null');
    if (nonNull.length === 1) {
      const inner = convert({ ...schema, type: nonNull[0] });
      const result = hasNull ? inner.nullable() : inner;
      return schema.description ? result.describe(schema.description) : result;
    }
    if (nonNull.length > 1) {
      const unions = nonNull.map((t) => convert({ ...schema, type: t }));
      const u = z.union(unions as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
      const result = hasNull ? u.nullable() : u;
      return schema.description ? result.describe(schema.description) : result;
    }
    // 全是 null：z.null()
    return z.null();
  }

  switch (schema.type) {
    case 'string': {
      const s = z.string();
      return schema.description ? s.describe(schema.description) : s;
    }
    case 'number':
    case 'integer': {
      const s = z.number();
      return schema.description ? s.describe(schema.description) : s;
    }
    case 'boolean': {
      const s = z.boolean();
      return schema.description ? s.describe(schema.description) : s;
    }
    case 'array': {
      const items = schema.items ? convert(schema.items) : z.any();
      const s = z.array(items);
      return schema.description ? s.describe(schema.description) : s;
    }
    case 'object': {
      // 无 properties = 自由字典（additionalProperties 形态：env / headers 这类键名不定的映射）。
      // 不能落 z.object({})——zod 的 object 默认 strip，会把所有键**静默剥光**且不报错，
      // 工具拿着空对象照常"成功"返回，是算错而非失灵（实测 {API_KEY:'x'} → {}；
      // mcp_install 的 env 就是这个形态，claude-code 后端下用户填的 token 一直在这里丢）。
      if (!schema.properties) {
        const s = z.record(z.string(), z.any());
        return schema.description ? s.describe(schema.description) : s;
      }
      const required = new Set(schema.required ?? []);
      const shape: Record<string, ZodTypeAny> = {};
      const props = schema.properties;
      for (const [key, sub] of Object.entries(props)) {
        const inner = convert(sub);
        shape[key] = required.has(key) ? inner : inner.optional();
      }
      const s = z.object(shape);
      return schema.description ? s.describe(schema.description) : s;
    }
    default:
      return z.any();
  }
}

/**
 * 给 engine.mcp.defineTool 用：返回的是 ZodObject 的 .shape——
 * 因为 SDK 内部会自己 z.object() 包一层，shape 是它真正期望的格式。
 *
 * 注意：仅当 root schema 是 object 时有意义；非 object 直接抛错。
 */
export function jsonSchemaToZodShape(schema: object): Record<string, ZodTypeAny> {
  const root = (schema ?? {}) as JsonSchema;
  // properties 可能为空（无参数工具），但 type 必须是 'object'
  const isObject = root.type === 'object' || (Array.isArray(root.type) && root.type.includes('object'));
  if (!isObject) {
    throw new Error('jsonSchemaToZodShape: root schema must be object');
  }
  if (!root.properties) {
    return {};
  }
  const required = new Set(root.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, sub] of Object.entries(root.properties)) {
    const inner = convert(sub);
    shape[key] = required.has(key) ? inner : inner.optional();
  }
  return shape;
}
