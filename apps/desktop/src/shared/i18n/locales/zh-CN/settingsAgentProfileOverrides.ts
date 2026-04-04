export const zhCNSettingsAgentProfileOverrides = {
  agentProfile: {
    profiles: {
      auto: {
        label: '\u81ea\u52a8\uff08\u5df2\u4f18\u5316\uff09',
        description: '\u5728\u5404\u4e2a\u9636\u6bb5\u4f7f\u7528 Opus\uff0c\u5e76\u5957\u7528\u4f18\u5316\u7684\u601d\u8003\u7ea7\u522b'
      },
      complex: {
        label: '\u590d\u6742\u4efb\u52a1',
        description: '\u9002\u5408\u5927\u578b\u6216\u9ad8\u96be\u5ea6\u4efb\u52a1\u7684\u6700\u9ad8\u80fd\u529b\u914d\u7f6e'
      },
      balanced: {
        label: '\u5747\u8861',
        description: '\u9002\u5408\u65e5\u5e38\u5de5\u4f5c\u7684\u80fd\u529b\u3001\u901f\u5ea6\u4e0e\u6210\u672c\u5e73\u8861'
      },
      quick: {
        label: '\u5feb\u901f\u4fee\u6539',
        description: '\u9002\u5408\u5c0f\u578b\u3001\u805a\u7126\u7f16\u8f91\u7684\u66f4\u5feb\u54cd\u5e94'
      },
      custom: {
        label: '\u81ea\u5b9a\u4e49',
        description: '\u9009\u62e9\u6a21\u578b\u4e0e\u601d\u8003\u7ea7\u522b'
      }
    },
    thinkingLevels: {
      low: '\u4f4e',
      medium: '\u4e2d',
      high: '\u9ad8',
      xhigh: '\u6781\u9ad8'
    }
  }
} as const;
