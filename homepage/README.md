# homepage

产品首页与文档入口。文档面向使用者，讲用法、边界与验收口径。

## 结构

| 路径 | 用途 |
|------|------|
| `index.html` | 首页：版本表、能力矩阵、快速验证命令、文档入口 |
| `documents/zh-hans/index.md` | 文档索引与版本/能力速览 |
| `documents/zh-hans/01-quickstart.md` | 三个绑定的最小可运行示例与外部校验 |
| `documents/zh-hans/02-bindings.md` | 绑定选择与共同约定 |
| `documents/zh-hans/03-limits.md` | 边界、拒绝行为与外部真值规则 |

`index.html` 是自包含静态页面，直接双击即可查看，不需要构建。

## 维护规则

- 版本与能力表跟 `projects/sqlite.rs` 的绑定实际导出一致，改动绑定面时同步更新。
- 示例必须能在本仓直接跑通；跑不通的示例要么删除，要么在文中标注为未支持。
