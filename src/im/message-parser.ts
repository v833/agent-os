/**
 * 飞书消息语义解析层：把 SDK 原始 mentions 和 content 字符串
 * 转换为稳定的提及、可读文本和可下载资源描述。
 */
export interface Mention {
  key: string;
  name: string;
  openId: string;
}

export interface MessageResource {
  type: "image" | "file";
  key: string;
  fileName?: string;
}

/** 从事件的 mentions 数组中提取结构化提及信息。 */
export function parseMentions(raw: any[] | undefined): Mention[] {
  if (!raw?.length) return [];

  return raw.map((mention) => ({
    key: mention.key,
    name: mention.name ?? "",
    openId: mention.id?.open_id ?? "",
  }));
}

/** 把 @_user_N 占位符替换成 @显示名。 */
export function resolveMentions(text: string, mentions: Mention[]): string {
  let resolved = text;
  for (const mention of mentions) {
    resolved = resolved.replaceAll(mention.key, `@${mention.name}`);
  }
  return resolved.trim();
}

/** 从消息 content 中提取资源 key（image_key / file_key）。 */
export function extractResourceKeys(
  messageType: string,
  content: string,
): MessageResource[] {
  // 飞书事件外层已由 SDK 解析，但 content 仍是 JSON 字符串，需要再解析一层。
  const parsed = JSON.parse(content);
  const resources: MessageResource[] = [];

  if (messageType === "image" && parsed.image_key) {
    resources.push({ type: "image", key: parsed.image_key });
  }

  if (messageType === "file" && parsed.file_key) {
    resources.push({
      type: "file",
      key: parsed.file_key,
      fileName: parsed.file_name,
    });
  }

  if (messageType === "post") {
    // 富文本图片藏在二维元素数组中；这里只收集资源，不把 img/at 混入正文。
    const paragraphs: any[][] = parsed.content ?? [];
    for (const element of paragraphs.flat()) {
      if (element.tag === "img" && element.image_key) {
        resources.push({ type: "image", key: element.image_key });
      }
    }
  }

  return resources;
}
