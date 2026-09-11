import type { FunctionResultContent } from "../core/ir.js";

export function encodeToolResultOutput(result: FunctionResultContent): string {
  // OpenAI 的工具结果没有失败标记，将错误状态与原始文本一起放入结果正文。
  return result.isError ? JSON.stringify({ is_error: true, output: result.output }) : result.output;
}
