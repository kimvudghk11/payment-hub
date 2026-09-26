import { ServiceProductType } from '../../src/service/domain/service-product-type.entity';

const create = () => ServiceProductType.create({ serviceId: 'svc-1', code: 'PLAN', name: '구독 요금제' });

describe('ServiceProductType', () => {
  it('활성 상태로 만든다', () => {
    expect(create()).toMatchObject({ serviceId: 'svc-1', code: 'PLAN', name: '구독 요금제', isActive: true });
  });

  describe('update', () => {
    it('바뀐 필드 이름만 돌려준다 (중지·재개는 isActive)', () => {
      const productType = create();

      expect(productType.update({ isActive: false })).toEqual(['isActive']);
      expect(productType.update({ name: '요금제', isActive: false })).toEqual(['name']);
      expect(productType).toMatchObject({ name: '요금제', isActive: false });
    });

    it('값이 같으면 아무것도 바뀌지 않는다', () => {
      expect(create().update({ name: '구독 요금제', isActive: true })).toEqual([]);
    });
  });

  it('auditSnapshot은 코드·이름·활성 여부', () => {
    expect(create().auditSnapshot()).toEqual({ code: 'PLAN', name: '구독 요금제', isActive: true });
  });
});
