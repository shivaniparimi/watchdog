def unique(items):
    seen = []
    for item in items:
        if item not in seen:
            seen.append(item)
    return seen
