# OneToThree Master Backlog Final Target

Date: 2026-04-17

This file is the simple operating backlog for the final target state.

## 1. What Is Broken Now

### Auth / TOTP
- `POST /api/auth/login/2fa` is unstable and has produced 500 errors
- recent commit history shows repeated hotfixes around `otplib`
- current auth path is too brittle for production

### QR / Device Link
- QR payload generation and QR consumption do not match
- QR login and device-link concepts are mixed together
- TOTP-dependent QR path contains a server stub

### Message Delivery
- current implementation mixes legacy ciphertext fields with newer per-device fanout
- transport and persistence model are not cleanly unified
- multi-device consistency risk remains high

### Favorites / Saved / Bookmarks
- no complete feature module found
- either incomplete or not fully implemented

### Themes / UI
- md3 and other themes rely on heavy CSS overrides
- there is no unified token-driven visual system
- menu/layout placement is not yet strict enough

### Notifications
- push groundwork exists
- unread/badge/management story is incomplete
- needs proper Android/iOS reliability pass

### Calls
- current coturn + Cloudflare expectations are not aligned with your network/privacy constraints
- need a clear p2p-first deployment strategy

### Groups / Channels
- schema and locale groundwork exist
- end-to-end implementation is not yet product-complete

### Startup / Ops
- `start.sh` is useful but too heavy and too monolithic
- no lightweight starter mode
- no mesh scaling mode

## 2. Final Security Options

### Option A: Repair Current Vault Model

Description:
- keep the current browser-vault philosophy
- improve device fanout and local secret storage
- move critical storage from `localStorage` to `IndexedDB`

Pros:
- fastest to stabilize
- least rewrite

Cons:
- not truly Signal-class
- weaker forward secrecy story
- more legacy baggage

Recommendation:
- not the final target

### Option B: Recommended Final Model

Description:
- passkey primary login
- password fallback
- mandatory TOTP for sensitive actions
- separate vault password
- separate recovery key
- root identity key + per-device keys
- prekeys + ratcheting for direct chats
- sender keys for groups
- server stores only encrypted backups it cannot decrypt

Pros:
- strongest balance between security and usability
- realistic for this product
- good migration target

Cons:
- requires deep refactor

Recommendation:
- choose this as the main target

### Option C: Full Signal-Class End State

Description:
- X3DH-like setup
- Double Ratchet for direct chats
- stronger group crypto path
- explicit safety-number UX
- strict device trust semantics

Pros:
- maximum honesty and security

Cons:
- highest complexity

Recommendation:
- long-term upgrade path after Option B foundation lands

## 3. Final Calls Options

### Option 1: STUN Only

Pros:
- simple
- no TURN infra
- no app-server IP exposure via TURN

Cons:
- unreliable for many networks

### Option 2: Separate TURN VPS

Pros:
- best free practical option
- main app server IP can stay hidden
- relay host is isolated from app host

Cons:
- TURN host IP is public

Recommendation:
- good final practical deployment path

### Option 3: P2P-First + TURN Fallback

Pros:
- where direct P2P works, use it
- where it fails, fallback to TURN
- best reliability/usability tradeoff

Cons:
- more deployment/config complexity

Recommendation:
- final target

## 4. Final Deploy / Scale Options

### Option 1: Single-Node Easy Deploy

Description:
- one lightweight entrypoint script
- minimal flags
- one-host stack

Goal:
- `./start.sh up`
- `./start.sh quick`

### Option 2: Primary + Helper Relay Node

Description:
- second node dedicated to TURN / media / edge helper roles
- no full app migration needed

Goal:
- `./start.sh mesh`
- helper node joins and immediately contributes TURN/relay capacity

### Option 3: Multi-Node Mesh Foundation

Description:
- multiple nodes with role-based deployment
- edge, relay, media, storage helper, backup helper roles
- progressive path to serious scaling

Goal:
- simple bootstrap UX but room for future scale

Recommendation:
- useful as the first narrow implementation only

### Option 4: Full Role-Based Cluster Mesh

Description:
- primary node remains the control plane
- extra nodes can join with explicit roles
- roles can be enabled independently depending on capacity needs

Roles:
- `relay`: TURN / media relay
- `api`: stateless API + WebSocket node
- `worker`: background processing / fanout / cleanup / push helper
- `edge-storage`: future storage helper / CDN-facing helper layer
- `db-replica`: PostgreSQL replica for read scaling / backup / failover workflows

Goal:
- `./start.sh mesh` on a second server
- choose role(s)
- bootstrap from the primary
- receive shared config and trust material
- immediately start helping with real load

Recommendation:
- this is the real target for your scaling story
- the relay-only helper is just the first implementation slice, not the final design

## 5. Final Product Target

OneToThree final target:
- direct chats
- groups
- channels
- threads
- replies
- forwards
- reactions
- pins
- media
- favorites
- saved messages
- voice/video calls
- voice channels
- push notifications
- unread counters
- notification management
- strong device security
- polished mobile PWA behavior
- unified cyberpunk terminal design system

## 6. Final Design Target

All themes must:
- share one layout system
- share one spacing/radius/motion system
- share one token system
- differ by mood, not structure

Menu/layout rules:
- every menu item has one stable place
- top actions never drift between screens
- mobile drawer and desktop sidebar are structurally consistent
- settings are grouped by domain, not by random component history

## 7. Final Notifications Target

- service worker reliability
- Android and iOS tested behavior
- unread counter
- badge count
- per-chat mute
- mention-only mode
- quiet hours
- privacy previews
- notification management center

## 8. Final Optimization Target

- lighter startup script
- faster cold start
- reduced client bundle waste
- better cache boundaries
- smaller hydration hotspots
- more predictable background sync behavior
- scalable deployment roles

## 9. Final Repair List

1. stabilize auth and TOTP
2. replace QR/login confusion with one device-link protocol
3. unify message transport
4. complete favorites
5. rebuild themes into one design system
6. complete notification and unread management
7. redesign local vault and recovery
8. add passkeys
9. enforce device-centric security
10. finalize groups/channels/server model
11. simplify start scripts
12. add helper-node mesh deployment mode
13. harden calls with p2p-first + TURN fallback

## 10. Final Priority Order

### Must-fix core
1. auth / TOTP
2. QR / device linking
3. messages / delivery consistency
4. notification reliability
5. theme / layout system

### Must-fix architecture
6. vault / recovery redesign
7. passkeys
8. device-centric trust model
9. p2p-first calls deployment

### Product completion
10. favorites
11. groups
12. channels
13. threads
14. voice channels

### Ops and scale
15. lightweight starter
16. mesh helper deployment
17. production observability

## 11. Full Mesh Target

The final production platform should support:

### Primary node responsibilities
- source of configuration truth
- admin panel
- migrations
- secret issuance for helper nodes
- cluster membership registry

### API mesh
- multiple stateless API/WS nodes behind one public entry
- shared Redis
- shared DB
- shared media storage
- sticky-free session handling where possible

### Database strategy
- single primary first
- optional replicas later
- read scaling for search/profile/list endpoints
- backup/failover story documented

### Storage strategy
- shared object storage endpoint
- no per-node media islands
- eventual room for separate media edge nodes

### Worker strategy
- isolate cleanup, fanout retries, push work, media maintenance, audit aggregation

### What `start.sh mesh` must eventually do
- register helper node against primary
- pull signed cluster config
- provision role-specific env
- start only needed services
- expose health and role diagnostics
- support update/rejoin/leave flows
