import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { WsEventsService } from './ws/ws-events.service.js';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        // WS 桥以 stub 代替（Gateway 在 e2e/集成环境里才完整拉起）
        { provide: WsEventsService, useValue: { onlineCount: 0 } },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('health', () => {
    it('should report ok with ws online count', () => {
      const health = appController.getHealth();
      expect(health.status).toBe('ok');
      expect(health.wsOnline).toBe(0);
      expect(typeof health.uptime).toBe('number');
      expect(typeof health.ts).toBe('number');
    });
  });
});
