export const zhCNSettingsGitHubOverrides = {
  projectSections: {
    github: {
      title: 'GitHub',
      description: 'GitHub \u95ee\u9898\u540c\u6b65',
      integrationTitle: 'GitHub \u96c6\u6210',
      integrationDescription: '\u8fde\u63a5 GitHub \u4ee5\u8fdb\u884c\u95ee\u9898\u8ddf\u8e2a',
      syncDescription: '\u4e0e GitHub Issues \u540c\u6b65',
      enableIssues: {
        label: '\u542f\u7528 GitHub Issues',
        description: '\u540c\u6b65 GitHub Issues \u5e76\u81ea\u52a8\u521b\u5efa\u4efb\u52a1'
      },
      oauth: {
        connectedViaCli: '\u5df2\u901a\u8fc7 GitHub CLI \u8fde\u63a5',
        authenticatedAs: '\u5df2\u8ba4\u8bc1\u4e3a {{username}}',
        useDifferentToken: '\u4f7f\u7528\u5176\u4ed6\u4ee4\u724c',
        authenticationTitle: 'GitHub \u8ba4\u8bc1',
        useManualToken: '\u4f7f\u7528\u624b\u52a8\u4ee4\u724c'
      },
      manualToken: {
        label: '\u4e2a\u4eba\u8bbf\u95ee\u4ee4\u724c',
        useOAuthInstead: '\u6539\u7528 OAuth',
        helpPrefix: '\u524d\u5f80 ',
        helpLink: 'GitHub \u8bbe\u7f6e',
        helpMiddle: '\uff0c\u521b\u5efa\u5177\u6709 ',
        helpSuffix: ' \u6743\u9650\u7684\u4ee4\u724c'
      },
      repository: {
        label: '\u4ed3\u5e93',
        enterManually: '\u624b\u52a8\u8f93\u5165',
        loading: '\u6b63\u5728\u52a0\u8f7d\u4ed3\u5e93...',
        selectPlaceholder: '\u9009\u62e9\u4ed3\u5e93...',
        searchPlaceholder: '\u641c\u7d22\u4ed3\u5e93...',
        noMatching: '\u6ca1\u6709\u5339\u914d\u7684\u4ed3\u5e93',
        noneFound: '\u672a\u627e\u5230\u4ed3\u5e93',
        selected: '\u5df2\u9009\u62e9\uff1a',
        formatPrefix: '\u683c\u5f0f\uff1a',
        formatSuffix: '\uff08\u4f8b\u5982\uff1a{{example}}\uff09',
        loadFailed: '\u52a0\u8f7d\u4ed3\u5e93\u5931\u8d25'
      },
      connectionStatus: {
        title: '\u8fde\u63a5\u72b6\u6001',
        checking: '\u68c0\u67e5\u4e2d...',
        connectedTo: '\u5df2\u8fde\u63a5\u5230 {{repo}}',
        notConnected: '\u672a\u8fde\u63a5'
      },
      issuesAvailable: {
        title: '\u53ef\u7528 Issues',
        description: '\u53ef\u4ece\u4fa7\u8fb9\u680f\u8bbf\u95ee GitHub Issues\uff0c\u67e5\u770b\u3001\u6392\u67e5\u5e76\u57fa\u4e8e Issues \u521b\u5efa\u4efb\u52a1\u3002'
      },
      autoSync: {
        label: '\u52a0\u8f7d\u65f6\u81ea\u52a8\u540c\u6b65',
        description: '\u9879\u76ee\u52a0\u8f7d\u65f6\u81ea\u52a8\u83b7\u53d6 Issues'
      },
      defaultBranch: {
        label: '\u9ed8\u8ba4\u5206\u652f',
        description: '\u521b\u5efa\u4efb\u52a1\u5de5\u4f5c\u6811\u65f6\u4f7f\u7528\u7684\u57fa\u7840\u5206\u652f',
        autoDetect: '\u81ea\u52a8\u68c0\u6d4b\uff08main/master\uff09',
        searchPlaceholder: '\u641c\u7d22\u5206\u652f...',
        noBranchesFound: '\u672a\u627e\u5230\u5206\u652f',
        selectedBranchHelp: '\u6240\u6709\u65b0\u4efb\u52a1\u90fd\u5c06\u4ece {{branch}} \u5206\u652f\u521b\u5efa'
      },
      pushNewBranches: {
        label: '\u81ea\u52a8\u63a8\u9001\u65b0\u5206\u652f',
        description: '\u81ea\u52a8\u5c06\u65b0\u7684\u4efb\u52a1\u5206\u652f\u548c\u5de5\u4f5c\u6811\u5206\u652f\u63a8\u9001\u5230 GitHub\uff0c\u5e76\u81ea\u52a8\u8bbe\u7f6e\u4e0a\u6e38\u8ddf\u8e2a'
      },
      oauthFlow: {
        cliRequiredTitle: '\u9700\u8981 GitHub CLI',
        cliRequiredDescription: 'OAuth \u8ba4\u8bc1\u9700\u8981 GitHub CLI\uff08gh\uff09\u3002\u8fd9\u6837\u53ef\u4ee5\u5b89\u5168\u8ba4\u8bc1\uff0c\u65e0\u9700\u624b\u52a8\u521b\u5efa\u4ee4\u724c\u3002',
        installCli: '\u5b89\u88c5 GitHub CLI',
        installedIt: '\u6211\u5df2\u5b89\u88c5',
        installationInstructions: '\u5b89\u88c5\u8bf4\u660e\uff1a',
        installMac: 'macOS\uff1a',
        installWindows: 'Windows\uff1a',
        installLinux: 'Linux\uff1a\u8bbf\u95ee',
        connectTitle: '\u8fde\u63a5\u5230 GitHub',
        connectDescription: '\u70b9\u51fb\u4e0b\u65b9\u6309\u94ae\u901a\u8fc7 GitHub \u8ba4\u8bc1\u3002\u7cfb\u7edf\u4f1a\u6253\u5f00\u6d4f\u89c8\u5668\uff0c\u4f60\u53ef\u4ee5\u5728\u5176\u4e2d\u6388\u6743\u5e94\u7528\u3002',
        usingCliVersion: '\u4f7f\u7528 GitHub CLI {{version}}',
        authenticateButton: '\u4f7f\u7528 GitHub \u8ba4\u8bc1',
        authenticatingTitle: '\u8ba4\u8bc1\u4e2d...',
        completeInBrowser: '\u8bf7\u5728\u6d4f\u89c8\u5668\u4e2d\u5b8c\u6210\u8ba4\u8bc1\u3002\u6b64\u7a97\u53e3\u4f1a\u81ea\u52a8\u66f4\u65b0\u3002',
        waitingToStart: '\u6b63\u5728\u7b49\u5f85\u8ba4\u8bc1\u6d41\u7a0b\u542f\u52a8...',
        oneTimeCode: '\u4f60\u7684\u4e00\u6b21\u6027\u9a8c\u8bc1\u7801',
        copied: '\u5df2\u590d\u5236',
        copy: '\u590d\u5236',
        enterCodeInBrowser: '\u8bf7\u5728\u6d4f\u89c8\u5668\u4e2d\u8f93\u5165\u6b64\u9a8c\u8bc1\u7801\u4ee5\u5b8c\u6210\u8ba4\u8bc1\u3002',
        copyCodeThenOpenLink: '\u5148\u590d\u5236\u6b64\u9a8c\u8bc1\u7801\uff0c\u518d\u6253\u5f00\u4e0b\u65b9\u94fe\u63a5\u5b8c\u6210\u8ba4\u8bc1\u3002',
        openUrl: '\u6253\u5f00 {{url}}',
        successTitle: '\u8fde\u63a5\u6210\u529f',
        successConnectedAs: '\u5df2\u8fde\u63a5\u4e3a {{username}}',
        successConnected: '\u4f60\u7684 GitHub \u8d26\u6237\u73b0\u5df2\u8fde\u63a5',
        timeoutTitle: '\u8ba4\u8bc1\u8d85\u65f6',
        failedTitle: '\u8ba4\u8bc1\u5931\u8d25',
        manualTitle: '\u624b\u52a8\u5b8c\u6210\u8ba4\u8bc1',
        manualDescription: '\u6d4f\u89c8\u5668\u672a\u80fd\u81ea\u52a8\u6253\u5f00\u3002\u8bf7\u8bbf\u95ee\u4e0b\u65b9 URL \u5b8c\u6210\u8ba4\u8bc1\uff1a',
        openUrlInBrowser: '\u5728\u6d4f\u89c8\u5668\u4e2d\u6253\u5f00 URL',
        enterThisCode: '\u51fa\u73b0\u63d0\u793a\u65f6\uff0c\u8bf7\u8f93\u5165\u6b64\u9a8c\u8bc1\u7801\uff1a',
        errors: {
          checkCliFailed: '\u68c0\u67e5 GitHub CLI \u5931\u8d25',
          getTokenFailed: '\u83b7\u53d6\u4ee4\u724c\u5931\u8d25',
          authenticationFailed: '\u8ba4\u8bc1\u5931\u8d25',
          timeout: '\u8ba4\u8bc1\u8d85\u65f6\u3002\u8ba4\u8bc1\u7a97\u53e3\u6253\u5f00\u65f6\u95f4\u8fc7\u957f\uff0c\u8bf7\u91cd\u8bd5\u3002'
        }
      }
    }
  }
} as const;
