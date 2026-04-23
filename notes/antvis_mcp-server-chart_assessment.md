# antvis/mcp-server-chart 评估

## 基本信息
- Stars: 4003
- Pushed: 2026-02-25
- Open Issues: 12
- URL: https://github.com/antvis/mcp-server-chart

## 项目类型
TypeScript MCP server for chart generation using AntV

## 候选问题

### Issue #289 - generate_line_chart 横坐标无序导致图形错乱
- **描述**: 当数据中time字段不是按顺序排列时，图表横坐标会乱序
- **Comments**: 2
- **难度**: 中等 - 需要修改数据排序逻辑
- **状态**: 待深入分析

### Issue #286 - Issue with Axis Assignment in MCP Bar Chart
- **描述**: 用户指定Y轴作为类别名称、X轴作为评级时，输出中X和Y轴的标签被交换
- **Comments**: 0
- **难度**: 中等 - 需要理解图表轴分配逻辑
- **状态**: 待深入分析

## 结论
项目复杂度较高，issue修复需要深入理解图表生成逻辑。当前优先级：中等
建议：如果找不到更简单的项目，再回来深入分析。