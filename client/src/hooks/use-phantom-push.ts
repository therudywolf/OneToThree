import { useEffect, useCallback } from 'react';

export function usePhantomPush() {
  useEffect(() => {
    // Запрашиваем права на системные уведомления при загрузке
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  const triggerBackgroundPush = useCallback((title: string, body: string) => {
    // Срабатывает ТОЛЬКО если вкладка скрыта/свернута (Phantom State)
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const notification = new Notification(title, {
        body: body,
        icon: '/icon-192.png', // Убедись, что иконка есть в папке public
        badge: '/icon-192.png',
        tag: 'project13-message', // Группирует пуши
        silent: false, // Оставляем системный звук
      });

      notification.onclick = function () {
        window.focus(); // Возвращает фокус на вкладку при клике
        this.close();
      };
    }
  }, []);

  return { triggerBackgroundPush };
}