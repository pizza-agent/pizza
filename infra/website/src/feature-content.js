export const featureCopy = {
 en: {
  capabilitiesNav: 'Capabilities', designNav: 'How it works',
  workflow: {
   title: 'One sidekick. A workspace for every project.',
   body: 'Give your personal assistant a goal. Project agents work in their own context and send the results back.',
   assistant: 'Personal assistant', assistantNote: 'Your ongoing conversation', projects: ['Website', 'Product docs'], workspaceNote: 'Its own files and context', result: 'Results, together', resultNote: 'Back with your assistant',
   caption: 'How collaboration works: messages connect workspaces while each keeps its own project context.',
   notes: [
    ['Keep the conversation going.', 'You do not need to start a fresh session for every task. Pizza manages the context as the work continues.'],
    ['Keep the useful context.', 'Old tool results are masked and context is compacted when needed, reducing what the model carries into the next turn.'],
   ],
  },
  capabilities: {
   title: 'Work happens in more than one place.', body: 'Keep your projects, conversations, and recurring work connected to the same agent.',
   remoteTitle: 'Your remote machine is a workspace, too.', remoteBody: 'Connect over SSH. Pizza deploys the agent to the remote host, where it works with that project’s files and tools.', local: 'Local project', remote: 'SSH workspace',
   channelsTitle: 'Talk where you already are.', channelsBody: 'Slack, Discord, Telegram, Lark, voice, and webhooks can all reach the same agent through the gateway.',
   scheduleTitle: 'Keep recurring work on schedule.', scheduleBody: 'Schedule checks, summaries, and routine tasks. The persistent assistant can pick them up on a recurring schedule.', scheduleExample: 'Checks · Summaries · Follow-ups',
   note: 'Channels, voice, and remote access require their corresponding service and account setup.',
  },
  freedom: {
   modelsTitle: '40+ providers. Your choice of model.', modelsBody: 'Anthropic, OpenAI, Google, DeepSeek, GLM, Kimi, and more. Use an API key or a supported subscription login.',
   extensionsTitle: 'Add the capabilities you need.', extensionsBody: 'Connect apps through MCP. Add skills, hooks, extensions, and themes, or build on the SDK, JSON-RPC, and FS-RPC interfaces.',
  },
  design: {
   title: ['Built on events.', 'Made to keep going.'], body: 'Events keep the work connected. Explore the choices behind Pizza’s memory, tools, and interfaces.', source: 'Read the design notes', diagram: 'Architecture illustration',
   tabs: ['Event-driven', 'Branching memory', 'One execution tool', 'Shared runtime'],
   events: {
    title: 'An agent without while true.', body: 'Reactor advances each turn through an event-driven state machine. The immutable SQLite event log is the source for the interface, model context, and history tree.',
    note: 'Interrupts, retries, and parallel tool calls have explicit handlers. Recorded events make state easier to rebuild and inspect.', log: 'One event log', projections: 'Different views of the same history', views: ['Desktop interface', 'Model context', 'History tree'], next: 'Add the next event', restart: 'Start again',
    entries: [['USER_MESSAGE', 'A request arrives'], ['TOOL_EXECUTION_END', 'A tool returns its result'], ['FILE_MUTATION_APPLIED', 'A file change is recorded'], ['AGENT_MESSAGE_END', 'The assistant replies']],
   },
   memory: {
    title: 'Try another direction. Keep the original.', body: 'Fork from a message in the past. Continue along a new branch while keeping the earlier path available to revisit and compare.',
    note: 'A continuing conversation and a branchable history work together. Context compaction helps the conversation keep going.', root: 'A shared starting point', branchA: 'Build a desktop version', branchB: 'Try a CLI version', choose: 'Choose a path', active: 'Selected direction', retained: 'Earlier path retained',
   },
   tool: {
    title: 'One execution tool. Many ways to get work done.', body: 'The model calls a single CLI tool. Reading, writing, editing, and workspace messaging are commands behind that interface.',
    note: 'A small tool schema reduces repeated definitions in the model context. Extra instructions and capabilities can be loaded as needed.', label: 'One tool exposed to the model', actions: ['Read files', 'Write files', 'Edit content', 'Message a workspace'],
   },
   runtime: {
    title: 'Different entrances. The same agent underneath.', body: 'The desktop GUI, terminal UI, JSON-RPC, and one-shot print mode consume the same SessionFacade event stream.',
    note: 'Use Pizza interactively, automate a task, or embed it in your own tooling. The interfaces share the same agent runtime.', interfaces: ['Desktop GUI', 'Terminal TUI', 'JSON-RPC', 'Print mode'], engine: 'One shared runtime', stream: 'The same event stream',
   },
  },
 },
 zh: {
  capabilitiesNav: '能做什么', designNav: '设计理念',
  workflow: {
   title: '一个助理，照看每一个项目。',
   body: '把目标交给个人助理。项目里的 Agent 各自推进工作，再把结果送回来。',
   assistant: '个人助理', assistantNote: '一段持续的对话', projects: ['官网改版', '产品文档'], workspaceNote: '各自的文件与上下文', result: '成果汇总', resultNote: '回到助理，一起查看',
   caption: '协作方式示意：工作区通过消息沟通，各自保留项目上下文。',
   notes: [
    ['接着聊，不必反复开场。', '每件事都可以接在前面的对话里。Pizza 管理上下文，你继续推进手头的工作。'],
    ['把上下文留给有用的信息。', '旧工具结果按需遮罩，上下文在需要时自动压缩，减少下一轮重复携带的内容。'],
   ],
  },
  capabilities: {
   title: '你的工作，不只在一个地方。', body: '项目、日常对话和重复事务，都能交给同一套 Agent 处理。',
   remoteTitle: '远程机器，也能成为工作区。', remoteBody: '通过 SSH 连接主机，Pizza 将 Agent 部署到远端，在项目所在的机器上读写文件、调用工具。', local: '本地项目', remote: 'SSH 远程工作区',
   channelsTitle: '在你习惯的地方，找到它。', channelsBody: '通过 gateway，把 Slack、Discord、Telegram、飞书、语音和 webhook 接到同一个 Agent。',
   scheduleTitle: '重复的事，按计划继续。', scheduleBody: '把日常检查、整理和跟进设为周期任务，交给常驻助理按计划运行。', scheduleExample: '定期检查 · 内容整理 · 事项跟进',
   note: '聊天渠道、语音和远程连接，需配置对应服务与账号。',
  },
  freedom: {
   modelsTitle: '40+ 模型服务商，按你的习惯选。', modelsBody: 'Anthropic、OpenAI、Google、DeepSeek、GLM、Kimi 等。使用自己的 API Key，或受支持的订阅登录。',
   extensionsTitle: '需要什么能力，就添什么。', extensionsBody: '通过 MCP 连接应用，添加技能、hooks、扩展和主题。也可以使用 SDK、JSON-RPC 与 FS-RPC 接入自己的工具。',
  },
  design: {
   title: ['事件驱动，', '记忆有迹可循。'], body: '用事件把工作串起来。看看 Pizza 如何组织记忆、执行工具，以及不同的使用界面。', source: '阅读设计说明', diagram: '原理示意',
   tabs: ['事件驱动', '分支记忆', '单一执行工具', '统一运行时'],
   events: {
    title: '事件驱动的 Agent，没有 while true。', body: 'Reactor 用事件处理表驱动状态机，推进每一轮工作。不可变的 SQLite 事件日志，为界面、模型上下文和历史分支提供共同的数据来源。',
    note: '中断、重试和并行工具调用都有对应的事件处理。记录下来的事件，让状态更容易重建和排查。', log: '一份事件日志', projections: '同一段历史，不同的视图', views: ['桌面界面', '模型上下文', '历史分支'], next: '加入下一条事件', restart: '重新演示',
    entries: [['USER_MESSAGE', '收到一条请求'], ['TOOL_EXECUTION_END', '工具返回结果'], ['FILE_MUTATION_APPLIED', '记录文件修改'], ['AGENT_MESSAGE_END', '助理给出回复']],
   },
   memory: {
    title: '换个方向，也保留原来的路。', body: '从过去的一条消息分叉，继续尝试新的方案。原有路径仍然保留，可以回来查看、比较，再决定下一步。',
    note: '持续对话与树状历史相互配合。上下文自动压缩，让工作能够继续往前推进。', root: '同一段起始对话', branchA: '继续做桌面版', branchB: '试试命令行版', choose: '选择一条路径', active: '当前选择的方向', retained: '原有路径仍保留',
   },
   tool: {
    title: '一个执行工具，完成不同的工作。', body: '模型只需调用一个 CLI 工具。读取、写入、编辑文件，以及工作区之间的消息，都通过其中的命令完成。',
    note: '精简的工具 Schema，减少上下文里反复出现的定义。更多指令和能力在需要时加载。', label: '提供给模型的一个执行工具', actions: ['读取文件', '写入文件', '编辑内容', '联系工作区'],
   },
   runtime: {
    title: '从不同入口，找到同一个 Agent。', body: '桌面 GUI、终端 TUI、JSON-RPC 和单次 print 模式，消费同一套 SessionFacade 事件流。',
    note: '在界面里对话、自动执行任务，或把它嵌入自己的工具，都能使用同一套 Agent 运行时。', interfaces: ['桌面 GUI', '终端 TUI', 'JSON-RPC', 'Print 模式'], engine: '同一套 Agent 运行时', stream: '共享同一条事件流',
   },
  },
 },
};
