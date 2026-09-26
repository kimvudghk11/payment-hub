import { ServiceStatus } from '../../src/service/constants/service.constants';
import { Service } from '../../src/service/domain/service.entity';
import { expectBusinessError } from '../support/business-error';

const newService = () => Service.create({ code: 'SVC_A', name: '서비스 A', webhookUrl: 'https://a.example.com/hook' });
const NOW = new Date('2026-09-26T00:00:00.000Z');

describe('Service', () => {
  describe('create', () => {
    it('ACTIVE 상태, 삭제되지 않은 서비스를 만든다', () => {
      const service = newService();

      expect(service).toMatchObject({
        code: 'SVC_A',
        name: '서비스 A',
        webhookUrl: 'https://a.example.com/hook',
        status: ServiceStatus.ACTIVE,
        deletedAt: null,
        webhookSecretEnc: null,
      });
    });

    it('webhookUrl은 생략할 수 있다', () => {
      expect(Service.create({ code: 'SVC_B', name: 'B' }).webhookUrl).toBeNull();
    });
  });

  describe('rotateWebhookSecret', () => {
    it('암호화된 서명 키와 키 ID를 저장한다', () => {
      const service = newService();

      service.rotateWebhookSecret({ ciphertext: Buffer.from('enc'), keyId: 'v1' });

      expect(service.webhookSecretEnc).toEqual(Buffer.from('enc'));
      expect(service.webhookSecretKeyId).toBe('v1');
    });
  });

  describe('update', () => {
    it('바뀐 필드 이름만 돌려준다', () => {
      const service = newService();

      expect(service.update({ name: '서비스 A2' })).toEqual(['name']);
      expect(service.update({ name: '서비스 A2', webhookUrl: null })).toEqual(['webhookUrl']);
      expect(service.name).toBe('서비스 A2');
      expect(service.webhookUrl).toBeNull();
    });

    it('값이 같으면 아무것도 바뀌지 않는다', () => {
      expect(newService().update({ name: '서비스 A' })).toEqual([]);
    });
  });

  describe('suspend / resume', () => {
    it('ACTIVE → SUSPENDED → ACTIVE', () => {
      const service = newService();

      expect(service.suspend()).toBe(true);
      expect(service.status).toBe(ServiceStatus.SUSPENDED);
      expect(service.resume()).toBe(true);
      expect(service.status).toBe(ServiceStatus.ACTIVE);
    });

    it('이미 그 상태면 바꾸지 않고 false (멱등)', () => {
      const service = newService();

      expect(service.resume()).toBe(false);
      service.suspend();
      expect(service.suspend()).toBe(false);
    });
  });

  describe('delete', () => {
    it('deleted_at만 채운다 (soft delete)', () => {
      const service = newService();

      service.delete(NOW);

      expect(service.deletedAt).toEqual(NOW);
      expect(service.isDeleted).toBe(true);
    });
  });

  describe('삭제된 서비스', () => {
    const deleted = () => {
      const service = newService();
      service.delete(NOW);
      return service;
    };

    it.each([
      ['update', (s: Service) => s.update({ name: 'x' })],
      ['suspend', (s: Service) => s.suspend()],
      ['resume', (s: Service) => s.resume()],
      ['delete', (s: Service) => s.delete(NOW)],
      ['rotateWebhookSecret', (s: Service) => s.rotateWebhookSecret({ ciphertext: Buffer.from('x'), keyId: 'v1' })],
    ])('%s는 RESOURCE_NOT_FOUND (존재를 숨김)', (_, action) => {
      expectBusinessError(() => action(deleted()), 'RESOURCE_NOT_FOUND');
    });
  });

  describe('auditSnapshot', () => {
    it('감사 로그용 상태를 비밀값 없이 돌려준다', () => {
      const service = newService();
      service.rotateWebhookSecret({ ciphertext: Buffer.from('enc'), keyId: 'v1' });

      const snapshot = service.auditSnapshot();

      expect(snapshot).toEqual({
        code: 'SVC_A',
        name: '서비스 A',
        status: 'ACTIVE',
        webhookUrl: 'https://a.example.com/hook',
        deletedAt: null,
      });
      expect(JSON.stringify(snapshot)).not.toContain('enc');
    });
  });
});
