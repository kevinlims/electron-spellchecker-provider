import {timer, Observable} from 'rxjs';
import {map, switchAll} from 'rxjs/operators'

const newCoolOperators = {
  guaranteedThrottle: function (time, scheduler=null) {
    return this.pipe(
      map((x) => timer(time, scheduler).pipe(map(() => x))),
      switchAll());
  }
};

for (let key of Object.keys(newCoolOperators)) {
  Observable.prototype[key] = newCoolOperators[key];
}
