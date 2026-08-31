<script lang="ts">
  let conversations = $state([
    { id: 1, name: "张三", avatar: "张", lastMessage: "好的，明天见！", time: "10:30", unread: 2, online: true },
    { id: 2, name: "李四", avatar: "李", lastMessage: "文件已经发送了", time: "昨天", unread: 0, online: false },
    { id: 3, name: "王五", avatar: "王", lastMessage: "周末有空吗？", time: "昨天", unread: 1, online: true },
    { id: 4, name: "赵六", avatar: "赵", lastMessage: "收到，谢谢", time: "周一", unread: 0, online: false },
    { id: 5, name: "产品讨论组", avatar: "产", lastMessage: "Alice: 下个版本什么时候发布？", time: "周一", unread: 5, online: false },
    { id: 6, name: "陈七", avatar: "陈", lastMessage: "哈哈", time: "8/28", unread: 0, online: true },
    { id: 7, name: "刘八", avatar: "刘", lastMessage: "[图片]", time: "8/27", unread: 0, online: false },
  ]);

  let selectedId = $state<number | null>(null);

  function selectConversation(id: number) {
    selectedId = id;
  }
</script>

<div class="flex h-screen bg-background">
  <!-- Conversation List -->
  <div class="w-80 border-r bg-card flex flex-col">
    <!-- Header -->
    <div class="flex items-center justify-between border-b px-4 py-3">
      <h1 class="text-xl font-semibold text-foreground">消息</h1>
      <button class="rounded-full p-2 hover:bg-muted transition-colors">
        <svg class="h-5 w-5 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </button>
    </div>

    <!-- Search -->
    <div class="px-3 py-2">
      <div class="relative">
        <svg class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input
          type="text"
          placeholder="搜索"
          class="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>
    </div>

    <!-- Conversation Items -->
    <div class="flex-1 overflow-y-auto">
      {#each conversations as conv (conv.id)}
        <button
          onclick={() => selectConversation(conv.id)}
          class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 {selectedId === conv.id ? 'bg-muted/70' : ''}"
        >
          <!-- Avatar -->
          <div class="relative flex-shrink-0">
            <div class="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground font-medium">
              {conv.avatar}
            </div>
            {#if conv.online}
              <div class="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-white bg-green-500"></div>
            {/if}
          </div>

          <!-- Content -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between">
              <span class="font-medium text-foreground truncate">{conv.name}</span>
              <span class="text-xs text-muted-foreground flex-shrink-0">{conv.time}</span>
            </div>
            <div class="flex items-center justify-between mt-0.5">
              <p class="text-sm text-muted-foreground truncate">{conv.lastMessage}</p>
              {#if conv.unread > 0}
                <span class="ml-2 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                  {conv.unread}
                </span>
              {/if}
            </div>
          </div>
        </button>
      {/each}
    </div>
  </div>

  <!-- Chat Area (placeholder) -->
  <div class="flex flex-1 items-center justify-center bg-muted/30">
    <div class="text-center">
      <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
        <svg class="h-8 w-8 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <p class="text-muted-foreground">选择一个对话开始聊天</p>
    </div>
  </div>
</div>
