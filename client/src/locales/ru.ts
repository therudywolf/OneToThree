const ru = {
  'common.back': 'Назад',
  'common.next': 'Далее',
  'common.skip': 'Пропустить',
  'common.saved': 'Сохранено',
  'common.settings': 'Настройки',
  'common.language': 'Язык',
  'common.openChatAria': 'Открыть чат',
  'common.peerInputAria': 'UUID или имя пользователя',
  'common.copyInviteAria': 'Скопировать мою ссылку-приглашение',
  'common.createGroupAria': 'Создать E2E группу',
  'common.toggleLanguageAria': 'Переключить язык',

  'login.usernameRequired': 'Требуется имя пользователя.',
  'login.passwordRequired': 'Требуется парольная фраза.',
  'login.pinMin8':
    'Для новых ключей парольная фраза должна быть не короче 8 символов.',
  'login.noLocalVault':
    'Для этого пользователя нет локального vault. Сначала зарегистрируйтесь на этом устройстве.',
  'login.vaultExists':
    'Для этого пользователя уже есть vault. Используйте вход.',
  'login.unwrapFailed': 'Неверная парольная фраза или поврежденный vault.',
  'login.invalidVaultFormat': 'Данные vault имеют неверный формат.',
  'login.legacyVault':
    'Этот vault создан до ECDSA-авторизации. Зарегистрируйте новый логин или очистите локальные данные.',
  'login.invalidSigningKey':
    'Не удалось загрузить ключ подписи из vault.',
  'login.signFailed': 'Не удалось подписать challenge.',
  'login.challengeFailed': 'Не удалось связаться с сервером авторизации.',
  'login.verifyFailed': 'Проверка не выполнена.',
  'login.unauthorized': 'Сессия недействительна.',
  'login.noChallenge': 'Нет активного challenge, попробуйте снова.',
  'login.nonceMismatch': 'Несовпадение challenge, попробуйте снова.',
  'login.signatureInvalid': 'Подпись отклонена сервером.',
  'login.publicKeyRequired':
    'Сервер ожидал публичный ключ (регистрация).',
  'login.publicKeyConflict':
    'Этот логин уже зарегистрирован на сервере с другим ключом. Войдите с тем же vault, выберите другое имя или сбросьте БД на сервере и локальные данные сайта.',
  'login.usernameTaken': 'Этот логин уже занят.',
  'login.invalidUsernameFormat':
    'Логин: 3–20 символов, только латиница, цифры, точка, подчёркивание или дефис (без пробелов и эмодзи).',
  'login.usernameReserved': 'Этот логин зарезервирован. Выберите другой.',
  'login.invalidBody': 'Неверный запрос.',
  'login.handleLabel': 'Логин',
  'login.vaultPassphraseLabel': 'Парольная фраза vault',
  'login.handlePlaceholder': 'оператор',
  'login.authLoading': 'Проверка сессии...',
  'login.newDevice': 'Новое устройство',
  'login.existingVault': 'Существующий vault',
  'login.tosRegisterTitle': '[ RU ] Пользовательское соглашение',
  'login.tosRegisterBody': `Приватность и Шифрование: Сервис предоставляет сквозное (End-to-End) шифрование. Мы физически не имеем доступа к вашим сообщениям и ключам. Потеря пароля от Сейфа означает безвозвратную потерю доступа к переписке.

Свободная зона (Zero Liability): Вход в систему означает полное согласие с тем, что вы действуете на свой страх и риск. Это свободное пространство. Мы не модерируем контент, не несем за него ответственности и нас не волнует, как вы используете этот инструмент. Каждый пользователь лично отвечает за свои действия.

Ограничение ответственности: Сервис предоставляется "как есть". Администрация не несет ответственности за ущерб, потерю данных или последствия использования приложения.

Право на изоляцию: Это частный бункер. Администрация оставляет за собой право заблокировать (забанить) любой аккаунт без объяснения причин, если он угрожает стабильности системы.`,

  'guide.step': 'Шаг',
  'guide.onboardingTitle': 'Онбординг',
  'guide.enter': 'Войти в Project 13',
  'guide.keyGeneration.title': 'Генерация ключей',
  'guide.keyGeneration.body':
    'При регистрации браузер создает две пары ключей: ECDSA (авторизация) и ECDH (E2E шифрование). Приватные ключи не покидают устройство.',
  'guide.vaultEncryption.title': 'Шифрование vault',
  'guide.vaultEncryption.body':
    'Приватные ключи упаковываются AES-256-GCM с ключом из парольной фразы (PBKDF2, 210k итераций). Зашифрованный vault хранится в localStorage.',
  'guide.zeroKnowledge.title': 'Zero knowledge',
  'guide.zeroKnowledge.body':
    'Сервер хранит только публичные ключи и зашифрованные сообщения. Он не может читать сообщения или расшифровывать медиа.',
  'guide.discoverability.title': 'Обнаруживаемость',
  'guide.discoverability.body':
    'Можно скрыться из поиска по нику в настройках (Обнаруживаемость). Чтобы искать других по имени, у них тоже должна быть включена опция; ссылки-приглашения работают всегда.',
  'guide.backup.title': 'Резервная копия vault',
  'guide.backup.body':
    'Используйте Settings -> Export Vault, чтобы сохранить зашифрованную копию. На новом устройстве импортируйте ее для восстановления доступа.',

  'sidebar.channels': 'Каналы',
  'sidebar.openDirect': 'Личный чат',
  'sidebar.peerPlaceholder': 'UUID или имя пользователя',
  'sidebar.copyInviteSuccess': 'Ссылка-приглашение скопирована',
  'sidebar.userNotFound': 'Пользователь не найден или скрыт',
  'sidebar.cannotOpenSelf': 'Нельзя открыть личный чат с самим собой',
  'sidebar.createFailed': 'Не удалось создать чат',

  'group.dialogAria': 'Создать зашифрованную группу',
  'group.title': '[ NEW_GROUP_E2E ]',
  'group.hintEcdh':
    'У каждого участника должен быть опубликован ECDH (один раз разблокируйте vault — ключи уйдут на сервер).',
  'group.channelName': '> CHANNEL_NAME',
  'group.optional': 'необязательно',
  'group.searchLabel': '> RADAR_SEARCH',
  'group.searchPlaceholder': 'ник, UUID или вставленная ссылка-приглашение',
  'group.scanning': 'СКАН…',
  'group.noHits':
    'НЕТ СОВПАДЕНИЙ — пользователь должен быть «обнаруживаем» в настройках, либо ищите по UUID / ссылке.',
  'group.noEcdhBadge': 'НЕТ_ECDH',
  'group.selectedLabel': ':: выбрано',
  'group.selectHint': 'Выберите хотя бы одного пользователя в списке выше.',
  'group.create': 'СОЗДАТЬ',
  'group.creating': '…',
  'group.cancel': 'ОТМЕНА',
  'group.noVault': 'Vault заблокирован — сначала разблокируйте vault.',
  'group.noSession': 'Нет id пользователя в сессии — перезагрузите страницу.',
  'group.needMember': 'Добавьте хотя бы одного другого участника.',
  'group.missingEcdh':
    'У пользователя «{name}» нет ECDH на сервере — ему нужно один раз разблокировать vault.',
  'group.lookupFailed': 'Не удалось загрузить профили с сервера.',
  'group.unknownUser': 'Один из пользователей не существует на сервере.',
  'group.createFailed': 'Не удалось создать группу.',
  'group.timeout': 'Таймаут запроса — повторите или проверьте сеть.',
  'group.serverInvalid': 'Некорректный запрос к серверу.',
  'group.serverDuplicate': 'Дубликат участника в запросе.',
  'group.creatorMissing': 'Создатель должен быть в списке участников.',

  'settings.discoverable': 'Обнаруживаемость',
  'settings.discoverableHint':
    'Другие смогут найти вас по нику. Чтобы найти кого-то по нику, эта опция должна быть включена у него.',
  'settings.discoverableBadgeOn': '● видны в поиске по нику',
  'settings.discoverableBadgeOff': '○ скрыты из поиска по нику',
  'settings.discoverableTooltipOn': 'Вас можно найти по нику (поиск)',
  'settings.discoverableTooltipOff': 'Вас нет в поиске по нику',
  'settings.loadFailed': 'Не удалось загрузить настройки (сеть или сессия)',
  'settings.vaultBackup': 'Резервная копия vault',
  'settings.languageHint': 'Выберите язык интерфейса',
  'settings.noLocalVault': 'Локальный vault не найден',
  'settings.invalidVaultFile': 'Некорректный файл vault',
  'settings.importFailed': 'Не удалось импортировать',
  'settings.toggleFailed': 'Не удалось обновить настройку',
  'settings.unknown': 'Неизвестная ошибка',
  'settings.dangerZone': 'Опасная зона',
  'settings.purgeHint':
    'Очищает localStorage, sessionStorage и IndexedDB сообщений — для отладки битого локального состояния.',
  'settings.purgeLocalCache': 'ОЧИСТИТЬ ЛОКАЛЬНЫЙ КЭШ',
} as const

export default ru

