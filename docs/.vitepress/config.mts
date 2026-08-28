import { defineConfig } from 'vitepress'

export default defineConfig({
  title: "Agent OS",
  description: "把飞书变成 AI 编程 CLI 的智能指挥台",
  head: [
    ['link', { rel: 'icon', href: '/logo.png' }]
  ],
  themeConfig: {
    logo: '/logo.png',
    siteTitle: 'Agent OS',
    nav: [
      { text: '首页', link: '/' },
      { text: '快速上手', link: '/guide/getting-started' },
      { text: '使用说明书', link: '/guide/user-manual' },
      { text: '团队协作', link: '/guide/team-agents' },
      { text: '命令大全', link: '/guide/commands' }
    ],
    sidebar: [
      {
        text: '新手指南',
        items: [
          { text: '产品简介与价值', link: '/guide/what-is-agent-os' },
          { text: '5 分钟快速上手', link: '/guide/getting-started' }
        ]
      },
      {
        text: '核心功能手册',
        items: [
          { text: '完整使用说明书', link: '/guide/user-manual' },
          { text: '团队 Bot 协作流程', link: '/guide/team-agents' },
          { text: '斜杠命令全解析', link: '/guide/commands' },
          { text: '定时任务', link: '/guide/schedule' },
          { text: '任务看板', link: '/guide/board' },
          { text: '并行编排', link: '/guide/orchestration' },
          { text: '可观测性大盘', link: '/guide/observability' },
          { text: 'CLI 登录', link: '/guide/login' }
        ]
      },
      {
        text: '运维与进阶',
        items: [
          { text: '常见问题与排查', link: '/guide/faq' },
          { text: '竞品对比与补全方向', link: '/guide/comparison-botmux' }
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/v833/agent-os' }
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Agent OS Team'
    },
    docFooter: {
      prev: '上一篇',
      next: '下一篇'
    }
  }
})
