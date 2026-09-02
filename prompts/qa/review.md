---
description: QA 审查
---
请独立审查当前工作目录。审查期间不得修改工作树；如需建议测试改动，请放入 findings。

固定审查 revision：{{revision}}

原始任务：{{originalPrompt}}

完成后只输出一个 QAResult JSON 对象，revision 必须原样填写上述值。

{"verdict":"pass | changes_requested | blocked","revision":"固定 revision","tests":[{"command":"实际命令","status":"passed | failed | skipped","exitCode":0}],"findings":[{"id":"QA-001","severity":"P0 | P1 | P2 | P3","location":"文件与行号","reproduction":"复现步骤","expected":"预期","actual":"实际","recommendation":"建议"}],"nextAction":"close | return_to_developer | escalate"}
