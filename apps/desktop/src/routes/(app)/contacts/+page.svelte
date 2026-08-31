<script lang="ts">
  let contacts = $state([
    { id: 1, name: "张三", avatar: "张", status: "online", signature: "今天天气不错" },
    { id: 2, name: "李四", avatar: "李", status: "offline", signature: "忙碌中..." },
    { id: 3, name: "王五", avatar: "王", status: "online", signature: "周末有空吗？" },
    { id: 4, name: "赵六", avatar: "赵", status: "offline", signature: "" },
    { id: 5, name: "陈七", avatar: "陈", status: "online", signature: "在吗？" },
    { id: 6, name: "刘八", avatar: "刘", status: "offline", signature: "" },
    { id: 7, name: "周九", avatar: "周", status: "online", signature: "明天开会" },
    { id: 8, name: "吴十", avatar: "吴", status: "offline", signature: "" },
    { id: 9, name: "郑十一", avatar: "郑", status: "online", signature: "项目进展顺利" },
    { id: 10, name: "钱十二", avatar: "钱", status: "offline", signature: "" },
  ]);

  let searchQuery = $state("");

  let filteredContacts = $derived(
    contacts.filter((c) =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase())
    )
  );
</script>

<div class="flex h-full w-full overflow-hidden bg-background">
  <!-- Sidebar -->
  <div class="w-80 border-r bg-card flex flex-col">
    <!-- Header -->
    <div class="flex items-center justify-between border-b px-4 py-3">
      <h1 class="text-xl font-semibold text-foreground">通讯录</h1>
      <button class="rounded-full p-2 hover:bg-muted transition-colors">
        <svg class="h-5 w-5 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <line x1="19" y1="8" x2="19" y2="14"/>
          <line x1="22" y1="11" x2="16" y2="11"/>
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
          placeholder="搜索联系人"
          bind:value={searchQuery}
          class="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>
    </div>

    <!-- Contact List -->
    <div class="flex-1 overflow-y-auto">
      {#each filteredContacts as contact (contact.id)}
        <button
          class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
        >
          <!-- Avatar -->
          <div class="relative flex-shrink-0">
            <div class="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground font-medium text-sm">
              {contact.avatar}
            </div>
            {#if contact.status === "online"}
              <div class="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-green-500"></div>
            {/if}
          </div>

          <!-- Info -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between">
              <span class="font-medium text-foreground text-sm">{contact.name}</span>
            </div>
            <p class="text-xs text-muted-foreground truncate mt-0.5">{contact.signature || "暂无签名"}</p>
          </div>
        </button>
      {/each}

      {#if filteredContacts.length === 0}
        <div class="px-4 py-8 text-center text-sm text-muted-foreground">
          未找到联系人
        </div>
      {/if}
    </div>
  </div>

  <!-- Detail Area (placeholder) -->
  <div class="flex flex-1 items-center justify-center bg-muted/30">
    <div class="text-center">
      <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
        <svg class="h-8 w-8 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
      </div>
      <p class="text-muted-foreground">选择联系人查看详情</p>
    </div>
  </div>
</div>
