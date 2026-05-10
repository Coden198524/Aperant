# 3D网络游戏开发质量标准

## 概述

本文档定义了针对3D网络游戏开发的代码质量标准和最佳实践。这些标准已集成到 Autocode 的 AI 代理系统中。

---

## 性能基准

### 帧率要求
- **目标**: <16.6ms/帧 (60 FPS 最低)
- **理想**: <8.3ms/帧 (120 FPS 竞技游戏)
- **不可接受**: >33ms 帧尖峰（导致可见卡顿）

### 内存管理
- **每帧分配**: <1KB（避免 GC 暂停）
- **10分钟增长**: <10MB
- **GC 频率**: <1次/秒
- **集合预分配**: 使用已知容量初始化

### 网络性能
- **往返延迟**: <100ms（竞技: <50ms）
- **每玩家带宽**: <10KB/s 上行
- **状态同步率**: 20-30Hz（非关键实体）
- **物理更新**: 50Hz 固定时间步

### 渲染性能
- **绘制调用**: <500（移动端）, <2000（桌面端）
- **物理射线检测**: <10次/帧
- **批处理**: 使用静态批处理和 GPU 实例化

---

## 强制性代码模式

### 1. 对象池（Object Pooling）

**目的**: 避免频繁的 Instantiate/Destroy 导致 GC 压力

```csharp
// ✅ 正确: 使用对象池
public class ProjectilePool : MonoBehaviour {
    private Queue<GameObject> pool = new Queue<GameObject>(100);
    
    public GameObject Get(GameObject prefab) {
        if (pool.Count > 0) {
            var obj = pool.Dequeue();
            obj.SetActive(true);
            return obj;
        }
        return Instantiate(prefab);
    }
    
    public void Return(GameObject obj, float delay) {
        StartCoroutine(ReturnAfterDelay(obj, delay));
    }
    
    private IEnumerator ReturnAfterDelay(GameObject obj, float delay) {
        yield return new WaitForSeconds(delay);
        obj.SetActive(false);
        pool.Enqueue(obj);
    }
}

// 使用
var projectile = objectPool.Get(projectilePrefab);
objectPool.Return(projectile, 3f);
```

```csharp
// ❌ 错误: 每帧分配
void Update() {
    if (Input.GetKeyDown(KeyCode.Space)) {
        Instantiate(projectilePrefab); // GC 压力
        Destroy(oldProjectile); // GC 压力
    }
}
```

---

### 2. 组件缓存

**目的**: 避免每帧调用 GetComponent（昂贵操作）

```csharp
// ✅ 正确: 在 Start/Awake 中缓存
public class Player : MonoBehaviour {
    private Rigidbody rb;
    private Animator animator;
    private Transform cachedTransform;
    
    void Awake() {
        rb = GetComponent<Rigidbody>();
        animator = GetComponent<Animator>();
        cachedTransform = transform; // transform 也应该缓存
    }
    
    void Update() {
        rb.velocity = newVelocity;
        animator.SetFloat("Speed", speed);
        cachedTransform.position += movement;
    }
}
```

```csharp
// ❌ 错误: 每帧 GetComponent
void Update() {
    GetComponent<Rigidbody>().velocity = newVelocity; // 每帧查找
    GetComponent<Animator>().SetFloat("Speed", speed); // 每帧查找
    transform.position += movement; // transform 查找也有开销
}
```

---

### 3. 距离检查优化

**目的**: 避免不必要的平方根计算

```csharp
// ✅ 正确: 使用平方距离
public class Enemy : MonoBehaviour {
    [SerializeField] private float attackRange = 5f;
    private float attackRangeSqr; // 缓存平方值
    
    void Start() {
        attackRangeSqr = attackRange * attackRange;
    }
    
    void Update() {
        float distSqr = (target.position - transform.position).sqrMagnitude;
        if (distSqr < attackRangeSqr) {
            Attack();
        }
    }
}
```

```csharp
// ❌ 错误: 不必要的 sqrt
void Update() {
    float dist = Vector3.Distance(target.position, transform.position); // sqrt 昂贵
    if (dist < attackRange) {
        Attack();
    }
}
```

---

### 4. 服务器权威（Server Authority）

**目的**: 防止作弊，确保游戏公平性

```csharp
// ✅ 正确: 服务器验证所有操作
public class CombatSystem : NetworkBehaviour {
    [ServerRpc]
    void DealDamageServerRpc(ulong targetId, int damage, ServerRpcParams rpcParams = default) {
        // 1. 验证发送者
        var senderId = rpcParams.Receive.SenderClientId;
        
        // 2. 验证范围
        if (!IsInAttackRange(senderId, targetId)) {
            Debug.LogWarning($"Player {senderId} tried to attack out of range");
            return;
        }
        
        // 3. 验证冷却时间
        if (!CanAttack(senderId)) {
            Debug.LogWarning($"Player {senderId} tried to attack during cooldown");
            return;
        }
        
        // 4. 验证视线
        if (!HasLineOfSight(senderId, targetId)) {
            Debug.LogWarning($"Player {senderId} tried to attack through walls");
            return;
        }
        
        // 5. 应用伤害（服务器权威）
        ApplyDamage(targetId, damage);
        
        // 6. 通知客户端
        NotifyDamageClientRpc(targetId, damage);
    }
    
    [ClientRpc]
    void NotifyDamageClientRpc(ulong targetId, int damage) {
        // 仅用于视觉反馈（血条、特效等）
        PlayDamageEffect(targetId, damage);
    }
}
```

```csharp
// ❌ 错误: 客户端直接修改状态
public class CombatSystem : MonoBehaviour {
    void OnHit(GameObject target) {
        // 客户端直接修改 - 可以作弊！
        target.GetComponent<Health>().TakeDamage(damage);
    }
}
```

---

### 5. 客户端预测（Client Prediction）

**目的**: 提供响应式的游戏体验，隐藏网络延迟

```csharp
// ✅ 正确: 客户端预测 + 服务器协调
public class PlayerMovement : NetworkBehaviour {
    private Vector3 predictedPosition;
    private Queue<InputState> inputHistory = new Queue<InputState>(60);
    
    void Update() {
        if (IsOwner) {
            // 1. 收集输入
            var input = GatherInput();
            
            // 2. 本地预测移动（立即响应）
            predictedPosition = PredictMovement(predictedPosition, input);
            transform.position = predictedPosition;
            
            // 3. 发送输入到服务器
            SendInputServerRpc(input);
            
            // 4. 保存输入历史用于协调
            inputHistory.Enqueue(input);
            if (inputHistory.Count > 60) inputHistory.Dequeue();
        }
    }
    
    [ServerRpc]
    void SendInputServerRpc(InputState input) {
        // 服务器验证并计算权威位置
        var serverPosition = ValidateAndMove(input);
        
        // 发送权威状态回客户端
        UpdatePositionClientRpc(serverPosition, input.timestamp);
    }
    
    [ClientRpc]
    void UpdatePositionClientRpc(Vector3 serverPosition, float timestamp) {
        if (!IsOwner) {
            // 其他玩家：直接使用服务器位置
            transform.position = serverPosition;
        } else {
            // 本地玩家：协调预测
            ReconcilePrediction(serverPosition, timestamp);
        }
    }
    
    void ReconcilePrediction(Vector3 serverPosition, float timestamp) {
        // 1. 检查预测误差
        float error = Vector3.Distance(serverPosition, predictedPosition);
        
        if (error > 0.1f) { // 误差阈值
            // 2. 从服务器位置重新应用输入历史
            predictedPosition = serverPosition;
            
            foreach (var input in inputHistory) {
                if (input.timestamp > timestamp) {
                    predictedPosition = PredictMovement(predictedPosition, input);
                }
            }
            
            // 3. 平滑插值到协调后的位置
            transform.position = Vector3.Lerp(transform.position, predictedPosition, 0.5f);
        }
    }
}
```

```csharp
// ❌ 错误: 等待服务器确认（延迟感明显）
public class PlayerMovement : NetworkBehaviour {
    void Update() {
        if (IsOwner) {
            var input = GatherInput();
            SendInputServerRpc(input);
            // 不做本地预测 - 玩家感觉延迟！
        }
    }
    
    [ServerRpc]
    void SendInputServerRpc(InputState input) {
        var newPosition = CalculatePosition(input);
        UpdatePositionClientRpc(newPosition);
    }
    
    [ClientRpc]
    void UpdatePositionClientRpc(Vector3 position) {
        transform.position = position; // 延迟 = 往返时间
    }
}
```

---

### 6. 固定时间步物理

**目的**: 确保物理模拟的确定性和一致性

```csharp
// ✅ 正确: 物理在 FixedUpdate，渲染在 Update
public class PhysicsCharacter : MonoBehaviour {
    private Rigidbody rb;
    private Vector3 moveInput;
    
    void Awake() {
        rb = GetComponent<Rigidbody>();
    }
    
    void Update() {
        // 收集输入（可变帧率）
        moveInput = new Vector3(Input.GetAxis("Horizontal"), 0, Input.GetAxis("Vertical"));
        
        // 更新动画和相机（渲染相关）
        UpdateAnimations();
        UpdateCamera();
    }
    
    void FixedUpdate() {
        // 应用物理（固定 50Hz）
        rb.AddForce(moveInput * moveSpeed);
        
        // 游戏逻辑（需要确定性）
        UpdateGameLogic();
    }
}
```

```csharp
// ❌ 错误: 物理在 Update（帧率依赖）
public class PhysicsCharacter : MonoBehaviour {
    void Update() {
        var moveInput = new Vector3(Input.GetAxis("Horizontal"), 0, Input.GetAxis("Vertical"));
        
        // 物理在可变帧率下 - 不一致！
        GetComponent<Rigidbody>().AddForce(moveInput * moveSpeed);
        
        // 高帧率 = 更快移动，低帧率 = 更慢移动
    }
}
```

---

## 性能测试要求

### 必须测试的场景

1. **压力测试**: 生成 100+ 实体
   - 验证: 帧时间保持 <16.6ms
   
2. **网络压力测试**: 模拟 32 个并发玩家
   - 验证: 带宽 <10KB/s/玩家
   
3. **内存泄漏测试**: 10分钟游戏会话
   - 验证: 内存增长 <10MB
   
4. **延迟模拟**: 200ms + 5% 丢包
   - 验证: 游戏保持响应性

### 性能分析工具

```bash
# Unity Profiler
# 检查: CPU 时间, GPU 时间, 内存分配

# 帧时间分析
# 目标: 平均 <16.6ms, 99th 百分位 <20ms

# 内存分析
# 检查: GC.Alloc 调用, 托管堆大小

# 网络分析
# 检查: 消息频率, 带宽使用, 延迟处理
```

---

## 常见反模式

### 1. Update 循环中的 FindObjectsOfType
```csharp
// ❌ 错误
void Update() {
    var enemies = FindObjectsOfType<Enemy>(); // 每帧扫描整个场景！
}

// ✅ 正确
private List<Enemy> enemies = new List<Enemy>(100);
void Start() {
    enemies.AddRange(FindObjectsOfType<Enemy>());
}
```

### 2. 循环中的字符串拼接
```csharp
// ❌ 错误
string result = "";
for (int i = 0; i < 1000; i++) {
    result += i.ToString(); // 每次创建新字符串
}

// ✅ 正确
var sb = new StringBuilder(1000);
for (int i = 0; i < 1000; i++) {
    sb.Append(i);
}
string result = sb.ToString();
```

### 3. 同步资源加载
```csharp
// ❌ 错误
void LoadLevel() {
    var texture = Resources.Load<Texture2D>("HugeTexture"); // 阻塞主线程
}

// ✅ 正确
IEnumerator LoadLevel() {
    var request = Resources.LoadAsync<Texture2D>("HugeTexture");
    yield return request;
    var texture = request.asset as Texture2D;
}
```

### 4. 缺少网络对象的空检查
```csharp
// ❌ 错误
void Update() {
    target.transform.position = newPos; // target 可能已被销毁
}

// ✅ 正确
void Update() {
    if (target != null && target.IsSpawned) {
        target.transform.position = newPos;
    }
}
```

### 5. 使用 SendMessage
```csharp
// ❌ 错误
gameObject.SendMessage("TakeDamage", 10); // 反射，慢，不安全

// ✅ 正确
var health = gameObject.GetComponent<Health>();
if (health != null) {
    health.TakeDamage(10);
}
```

---

## 安全性要求

### 输入验证（服务器端）

```csharp
[ServerRpc]
void MovePlayerServerRpc(Vector3 position, ServerRpcParams rpcParams = default) {
    var clientId = rpcParams.Receive.SenderClientId;
    
    // 1. 验证位置合理性
    if (position.y > 1000f || position.y < -100f) {
        Debug.LogWarning($"Invalid position from client {clientId}");
        return;
    }
    
    // 2. 验证移动速度
    var lastPos = GetPlayerPosition(clientId);
    var distance = Vector3.Distance(position, lastPos);
    var maxDistance = maxSpeed * Time.fixedDeltaTime * 2; // 2x 容错
    
    if (distance > maxDistance) {
        Debug.LogWarning($"Speed hack detected from client {clientId}");
        return;
    }
    
    // 3. 应用移动
    SetPlayerPosition(clientId, position);
}
```

### 关键资源哈希检查

```csharp
void ValidateAssets() {
    var expectedHash = "abc123...";
    var actualHash = ComputeHash(criticalAsset);
    
    if (expectedHash != actualHash) {
        Debug.LogError("Asset tampering detected!");
        DisconnectPlayer();
    }
}
```

---

## QA 检查清单

### 性能
- [ ] 帧时间 <16.6ms（正常负载）
- [ ] 无 >33ms 帧尖峰
- [ ] Update 循环中无分配
- [ ] 内存增长 <10MB/10分钟
- [ ] GC 收集 <1次/秒

### 网络
- [ ] 带宽 <10KB/s/玩家
- [ ] 200ms 延迟下可玩
- [ ] 服务器验证所有操作
- [ ] 客户端预测正常工作

### 渲染
- [ ] 绘制调用在预算内
- [ ] 无缺失材质
- [ ] LOD 系统工作
- [ ] 遮挡剔除启用

### 架构
- [ ] 对象池用于频繁生成
- [ ] 组件引用已缓存
- [ ] 物理在 FixedUpdate
- [ ] 距离检查使用 sqrMagnitude

### 安全
- [ ] 服务器验证输入范围
- [ ] 客户端消息限速
- [ ] 关键状态服务器权威
- [ ] 无敏感数据在客户端

---

## 集成到 Autocode

这些标准已集成到以下文件：

1. **`apps/desktop/prompts/coder.md`**
   - 新增 "3D NETWORK GAME DEVELOPMENT REQUIREMENTS" 章节
   - 包含性能要求、代码模式、检查清单

2. **`apps/desktop/prompts/qa_reviewer.md`**
   - 新增 "3D NETWORK GAME DEVELOPMENT QA PRIORITIES" 章节
   - 包含性能验证、游戏特定验证、测试命令

3. **`apps/desktop/src/main/ai/config/agent-configs.ts`**
   - 更新 coder 和 qa_reviewer 注释
   - 强调游戏开发关键点

---

## 参考资源

- Unity Performance Optimization: https://docs.unity3d.com/Manual/BestPracticeUnderstandingPerformanceInUnity.html
- Netcode for GameObjects: https://docs-multiplayer.unity3d.com/netcode/current/about/
- Game Programming Patterns: https://gameprogrammingpatterns.com/
- Real-Time Rendering: https://www.realtimerendering.com/

---

**版本**: v1.0  
**日期**: 2026-05-09  
**状态**: 已实施
