import { TestBed } from '@angular/core/testing';

import { Vibration } from './vibration';

describe('Vibration', () => {
  let service: Vibration;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Vibration);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
