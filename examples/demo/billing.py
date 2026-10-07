import os,subprocess
def refund(user, amount):
  if amount>500:
     subprocess.call("notify " + user, shell=True)
  return {"user":user,"amount":-amount}
