import {expect,test} from 'bun:test';
import {ComputePolicy} from './compute-policy.ts';
import example from '../remote-agent.config.example.json';
import {parseServiceFile} from './config.ts';
test('managed allocation limit is opt-in and allows an explicit zero',()=>{
 expect(ComputePolicy.parse({}).maxManagedAllocations).toBeUndefined();
 expect(parseServiceFile(example).machine.compute?.maxManagedAllocations).toBeUndefined();
 expect(ComputePolicy.parse({maxManagedAllocations:0}).maxManagedAllocations).toBe(0);
 expect(ComputePolicy.parse({maxManagedAllocations:1000}).maxManagedAllocations).toBe(1000);
});
test.each([-1,0.5,1001,'1',null])('invalid managed allocation limit %s is refused',value=>{
 expect(ComputePolicy.safeParse({maxManagedAllocations:value}).success).toBe(false);
});
