import { Notice, Setting } from 'obsidian';
import { c } from 'src/components/helpers';

import type { TeamManager } from '../TeamManager';
import type { TelegramStatus } from '../TeamClient';

/**
 * Settings → Mad Kanban → Telegram notifications. Obsidian can't push notifications to a
 * phone, so the team server's Telegram bot messages people instead.
 */
export function renderTelegramSection(containerEl: HTMLElement, team: TeamManager): () => void {
  const el = containerEl.createDiv({ cls: c('telegram-section') });
  let disposed = false;
  let pollTimer: number | null = null;

  const stopPolling = () => {
    if (pollTimer != null) window.clearInterval(pollTimer);
    pollTimer = null;
  };

  const render = async () => {
    if (disposed) return;
    el.empty();
    if (!team.user || !team.isConfigured) return;
    let st: TelegramStatus;
    try {
      st = await team.client.telegramStatus();
    } catch {
      return; // older server without notifications: show nothing
    }
    if (disposed) return;
    el.empty();

    const setting = new Setting(el).setName('Telegram notifications');
    if (!st.available) {
      setting.setDesc('Not set up on your team server yet. Ask your host.');
      return;
    }
    if (st.linked) {
      setting
        .setDesc(
          `On${st.telegramName ? ` for ${st.telegramName}` : ''}. You get a message from @${st.bot} when someone @mentions you, comments on your cards, assigns you, or moves one of your cards, plus a short note when Mad Kanban gets something new (send /updates off to the bot to skip those).`
        )
        .addButton((b) =>
          b
            .setButtonText('Turn off')
            .setWarning()
            .onClick(async () => {
              b.setDisabled(true);
              try {
                await team.client.telegramUnlink();
                new Notice('Mad Kanban: Telegram notifications are off.');
              } catch (e) {
                new Notice(`Could not turn off: ${(e as Error)?.message || e}`);
              }
              void render();
            })
        );
      return;
    }
    setting
      .setDesc(
        'Get a Telegram message when someone @mentions you, comments on your cards, assigns you, or moves one of your cards. Works even when Obsidian is closed.'
      )
      .addButton((b) =>
        b
          .setButtonText('Connect Telegram')
          .setCta()
          .onClick(async () => {
            b.setDisabled(true);
            try {
              const url = await team.client.telegramLink();
              window.open(url);
              new Notice('Mad Kanban: in Telegram, tap Start.', 8000);
              // Watch for the bot to confirm, for up to 3 minutes.
              stopPolling();
              const until = Date.now() + 3 * 60 * 1000;
              pollTimer = window.setInterval(async () => {
                if (disposed || Date.now() > until) return stopPolling();
                try {
                  const next = await team.client.telegramStatus();
                  if (next.linked) {
                    stopPolling();
                    new Notice('Mad Kanban: Telegram connected.');
                    void render();
                  }
                } catch {
                  /* keep waiting */
                }
              }, 3000);
            } catch (e) {
              new Notice(`Could not connect: ${(e as Error)?.message || e}`);
            } finally {
              b.setDisabled(false);
            }
          })
      );
  };

  const rerender = (): void => void render();
  team.emitter.on('user', rerender);
  void render();
  return () => {
    disposed = true;
    stopPolling();
    team.emitter.off('user', rerender);
  };
}
